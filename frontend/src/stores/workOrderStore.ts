/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  putFaults,
  putWorkOrder,
  removeWorkOrder,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  RESOURCE_OCCUPYING_STATES,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderPauseInput,
  type WorkOrderResumeDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import {
  findConflicts,
  findMachineConflicts,
  findMemberConflicts,
  findOccupiedResources,
  nowDateTime,
  windowMinutes,
  type TimeWindow,
} from '../utils/window';
import { emitChange } from '../utils/events';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  inspections: [],
  switches: [],
  yards: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

/** 归一化作业单行：兼容 v2 及更早快照中缺失的暂停 / 恢复字段 */
function normalizeWorkOrder(row: WorkOrderRow): WorkOrderRow {
  return {
    ...row,
    pausedReason: row.pausedReason ?? null,
    pausedAt: row.pausedAt ?? null,
    processedFaultIds: Array.isArray(row.processedFaultIds) ? row.processedFaultIds : [],
    pausedMembers: Array.isArray(row.pausedMembers) ? row.pausedMembers : [],
    pausedMachines: Array.isArray(row.pausedMachines) ? row.pausedMachines : [],
    members: Array.isArray(row.members) ? row.members : [],
    machines: Array.isArray(row.machines) ? row.machines : [],
  };
}

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, inspections, switches, yards] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
    ]);
    return { workOrders, faults, inspections, switches, yards };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 新建作业单：把勾选病害编排进同一时间窗，并回传时间窗冲突编号 */
export const createWorkOrder = createAsyncThunk<
  { created: boolean; conflicts: string[] },
  WorkOrderDraft,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const conflicts = findConflicts(
      { id: 'pending', windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      state.workOrders
        .filter((item) => RESOURCE_OCCUPYING_STATES.includes(item.state))
        .map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
        })),
    ).map((item) => item.code);

    await putWorkOrder({
      id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      code: draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      state: 'planned',
      pausedReason: null,
      pausedAt: null,
      processedFaultIds: [],
      pausedMembers: [],
      pausedMachines: [],
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    emitChange();
    return { created: true, conflicts };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新建作业单失败');
  }
});

export const updateWorkOrder = createAsyncThunk<
  void,
  { id: string; draft: WorkOrderDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/update', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return;
    if (existing.state === 'paused' || existing.state === 'done') return;
    await putWorkOrder({
      ...existing,
      code: draft.code.trim(),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      updatedAt: nowDateTime(),
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新作业单失败');
  }
});

/**
 * 推进作业单状态。
 * 推进到「已完成」时，把关联病害批量置为已销号（回写销号）。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; next: WorkOrderState },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/advance', async ({ id, next }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return { state: next, solvedCount: 0 };
    const allowed = WORK_ORDER_STATE_FLOW[existing.state];
    if (!allowed.includes(next)) return { state: existing.state, solvedCount: 0 };
    // 暂停态恢复必须走 resumeWorkOrder（重新核定人员机具），不允许直接推进
    if (existing.state === 'paused' && next === 'working') {
      return rejectWithValue('暂停单请通过「恢复作业」重新核定人员机具');
    }

    let solvedCount = 0;
    if (next === 'done') {
      const related = state.faults.filter(
        (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
      );
      if (related.length > 0) {
        await putFaults(
          related.map((item) => ({ ...item, state: 'solved' as const, solvedAt: nowDateTime() })),
        );
        solvedCount = related.length;
      }
    }
    await putWorkOrder({
      ...existing,
      state: next,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { state: next, solvedCount };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '推进作业单失败');
  }
});

/**
 * 作业中暂停：
 * - 登记暂停原因与时间；
 * - 把本次已处理病害销号并从本单摘除（释放后的作业单只保留剩余病害）；
 * - 清空本单占用的人员 / 机具（保留快照供恢复时沿用旧安排比对）。
 */
export const pauseWorkOrder = createAsyncThunk<
  { solvedCount: number; remainingCount: number },
  { id: string; input: WorkOrderPauseInput },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/pause', async ({ id, input }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return rejectWithValue('作业单不存在');
    if (existing.state !== 'working') return rejectWithValue('仅作业中的作业单可以暂停');

    const remainingFaults = state.faults.filter(
      (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
    );
    if (remainingFaults.length === 0) {
      return rejectWithValue('关联病害已全部处理，请直接推进为已完成');
    }
    const reason = input.reason.trim();
    if (!reason) return rejectWithValue('请登记暂停原因');

    const solvedIds = input.solvedFaultIds.filter((faultId) => existing.faultIds.includes(faultId));
    const solvedRows = state.faults.filter(
      (item) => solvedIds.includes(item.id) && item.state === 'pending',
    );
    if (solvedRows.length > 0) {
      await putFaults(
        solvedRows.map((item) => ({ ...item, state: 'solved' as const, solvedAt: nowDateTime() })),
      );
    }
    const solvedSet = new Set(solvedRows.map((item) => item.id));
    const remainingIds = existing.faultIds.filter(
      (faultId) => !solvedSet.has(faultId) && state.faults.some((f) => f.id === faultId && f.state === 'pending'),
    );
    if (remainingIds.length === 0) {
      return rejectWithValue('剩余待修病害为 0，无法暂停，请直接推进为已完成');
    }

    await putWorkOrder({
      ...existing,
      state: 'paused',
      faultIds: remainingIds,
      processedFaultIds: [...existing.processedFaultIds, ...solvedRows.map((item) => item.id)],
      pausedReason: reason,
      pausedAt: input.pausedAt?.trim() || nowDateTime(),
      // 暂停即释放人员机具，旧安排进快照
      members: [],
      machines: [],
      pausedMembers: existing.members,
      pausedMachines: existing.machines,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { solvedCount: solvedRows.length, remainingCount: remainingIds.length };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '暂停作业单失败');
  }
});

/**
 * 恢复作业：只带剩余病害生成恢复草稿（新时间窗 + 重新核定的人员机具）后回到作业中。
 * - recheck（按当前空闲重查）：所选人员 / 机具在新时间窗内不得被其它占用单占用；
 * - reuse（沿用旧安排）：暂停快照中的人员 / 机具在新时间窗内被别的单占用时拒绝恢复。
 */
export const resumeWorkOrder = createAsyncThunk<
  { state: WorkOrderState },
  { id: string; draft: WorkOrderResumeDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/resume', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return rejectWithValue('作业单不存在');
    if (existing.state !== 'paused') return rejectWithValue('仅已暂停的作业单可以恢复');
    if (existing.faultIds.length === 0) return rejectWithValue('该单已无剩余病害，请直接归档');

    if (windowMinutes({ windowStart: draft.windowStart, windowEnd: draft.windowEnd }) <= 0) {
      return rejectWithValue('天窗止必须晚于天窗起');
    }
    if (!draft.leader.trim()) return rejectWithValue('请选择负责人');
    if (draft.members.length === 0) return rejectWithValue('请分配作业人员');
    if (draft.machines.length === 0) return rejectWithValue('请分配机具');

    const occupying = state.workOrders
      .filter((item) => item.id !== existing.id && RESOURCE_OCCUPYING_STATES.includes(item.state))
      .map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        members: item.members,
        machines: item.machines,
      }));
    const occupied = findOccupiedResources(
      { windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      occupying,
    );
    if (draft.mode === 'reuse') {
      const busyMembers = draft.members.filter((name) => occupied.members.includes(name));
      const busyMachines = draft.machines.filter((name) => occupied.machines.includes(name));
      if (busyMembers.length > 0 || busyMachines.length > 0) {
        const details = [
          busyMembers.length > 0
            ? `人员 ${busyMembers.map((name) => `${name}（占用方 ${occupied.memberBy[name]}）`).join('、')}`
            : '',
          busyMachines.length > 0
            ? `机具 ${busyMachines.map((name) => `${name}（占用方 ${occupied.machineBy[name]}）`).join('、')}`
            : '',
        ]
          .filter(Boolean)
          .join('；');
        return rejectWithValue(`旧安排已有资源被别的单占用：${details}，请改用「按当前空闲重查」`);
      }
    } else {
      const busyMembers = draft.members.filter((name) => occupied.members.includes(name));
      const busyMachines = draft.machines.filter((name) => occupied.machines.includes(name));
      if (busyMembers.length > 0 || busyMachines.length > 0) {
        return rejectWithValue('所选资源在当前时间窗已被占用，请移除标红的人员 / 机具');
      }
    }

    await putWorkOrder({
      ...existing,
      state: 'working',
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      members: draft.members,
      machines: draft.machines,
      pausedReason: null,
      pausedAt: null,
      pausedMembers: [],
      pausedMachines: [],
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { state: 'working' };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '恢复作业单失败');
  }
});

export const deleteWorkOrder = createAsyncThunk<
  void,
  string,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/delete', async (id, { getState, rejectWithValue }) => {
  try {
    const existing = getState().workOrder.workOrders.find((item) => item.id === id);
    if (existing?.state === 'paused') {
      return rejectWithValue('暂停中的作业单不能删除，请先恢复或完成');
    }
    await removeWorkOrder(id);
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
  }
});

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders.map(normalizeWorkOrder);
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突与未销号数量 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter(
        (item) => item.id !== order.id && RESOURCE_OCCUPYING_STATES.includes(item.state),
      );
      const conflictCodes = others
        .filter((item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd)
        .map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
        processedFaultCount:
          order.processedFaultIds.length + related.filter((item) => item.state === 'solved').length,
        totalFaultCount: order.processedFaultIds.length + related.length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
  };
}

/** 恢复作业：给定作业单与拟定时间窗，按当前占用关系返回人员 / 机具空闲情况 */
export function selectResumeAvailability(
  state: RootLike,
  orderId: string,
  window: TimeWindow,
): {
  busyMembers: string[];
  busyMachines: string[];
  memberBy: Record<string, string>;
  machineBy: Record<string, string>;
} {
  const sources = state.workOrder.workOrders
    .filter((item) => item.id !== orderId && RESOURCE_OCCUPYING_STATES.includes(item.state))
    .map((item) => ({
      id: item.id,
      code: item.code,
      windowStart: item.windowStart,
      windowEnd: item.windowEnd,
      members: item.members,
      machines: item.machines,
    }));
  const occupied = findOccupiedResources(window, sources);
  return {
    busyMembers: occupied.members,
    busyMachines: occupied.machines,
    memberBy: occupied.memberBy,
    machineBy: occupied.machineBy,
  };
}
