/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 * 暂停 / 恢复：作业中登记暂停原因与时间并销掉已处理病害、释放人员机具；
 * 恢复时人员机具二选一（按当前空闲重查 / 沿用旧安排），只带剩余病害生成草稿。
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
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  WORK_ORDER_STATE_FLOW,
  buildWorkOrderCode,
  pauseBlockReason,
  resumeBlockReason,
  type ResumeDraft,
  type ResumeMode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import {
  endTimeOf,
  findConflicts,
  findMachineConflicts,
  findMemberConflicts,
  holdsResources,
  nowDateTime,
  occupiedResources,
  windowMinutes,
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
  /** 暂停单恢复时生成的草稿（跨页传递到编排台） */
  resumeDraft: ResumeDraft | null;
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
  resumeDraft: null,
  loading: false,
  error: '',
};

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
  WorkOrderDraft & { resumeFromOrderId?: string },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const conflicts = findConflicts(
      { id: 'pending', windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      state.workOrders
        .filter((item) => holdsResources(item.state))
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
      pauseReason: null,
      pausedAt: null,
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    // 恢复草稿保存：剩余病害从来源暂停单摘出，暂停单只留已处理病害作记录
    if (draft.resumeFromOrderId) {
      const source = state.workOrders.find((item) => item.id === draft.resumeFromOrderId);
      if (source) {
        const remaining = source.faultIds.filter((faultId) => !draft.faultIds.includes(faultId));
        if (remaining.length === 0) await removeWorkOrder(source.id);
        else await putWorkOrder({ ...source, faultIds: remaining, updatedAt: nowDateTime() });
      }
    }
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

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

/**
 * 登记暂停：记录原因与时间，把已处理病害销号，随后人员机具释放
 * （已暂停单不再参与时间窗 / 人员 / 机具占用校验）。
 * 已完成、未下达或无剩余病害的单不能暂停。
 */
export const pauseWorkOrder = createAsyncThunk<
  { solvedCount: number },
  { id: string; reason: string; pausedAt: string; solvedFaultIds: string[] },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/pause', async ({ id, reason, pausedAt, solvedFaultIds }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return rejectWithValue('作业单不存在');
    const pendingCount = state.faults.filter(
      (item) => existing.faultIds.includes(item.id) && item.state === 'pending',
    ).length;
    const blocked = pauseBlockReason(existing.state, pendingCount);
    if (blocked) return rejectWithValue(blocked);
    if (!reason.trim()) return rejectWithValue('请登记暂停原因');

    const handled = state.faults.filter(
      (item) => solvedFaultIds.includes(item.id) && existing.faultIds.includes(item.id) && item.state === 'pending',
    );
    if (handled.length > 0) {
      await putFaults(handled.map((item) => ({ ...item, state: 'solved' as const, solvedAt: pausedAt })));
    }
    await putWorkOrder({
      ...existing,
      state: 'paused',
      pauseReason: reason.trim(),
      pausedAt,
      updatedAt: nowDateTime(),
    });
    emitChange();
    return { solvedCount: handled.length };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '登记暂停失败');
  }
});

/** 从字典补空：保留当前仍空闲的旧安排，缺额按字典顺序用空闲资源补齐到原数量 */
export function pickFreeResources(oldList: string[], library: string[], busy: string[]): string[] {
  const kept = oldList.filter((name) => !busy.includes(name));
  const fill = library.filter((name) => !busy.includes(name) && !kept.includes(name));
  return [...kept, ...fill].slice(0, oldList.length);
}

/**
 * 生成恢复草稿：只带剩余（未销号）病害。
 * 人员机具二选一——「按当前空闲重查」剔除已被别的单占用的资源并按字典补齐；
 * 「沿用旧安排」原样带出（占用风险由编排台冲突预检提示）。
 */
export const prepareResumeDraft = createAsyncThunk<
  ResumeDraft,
  { id: string; mode: ResumeMode },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/prepareResume', async ({ id, mode }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return rejectWithValue('作业单不存在');
    const remainingIds = existing.faultIds.filter((faultId) =>
      state.faults.some((item) => item.id === faultId && item.state === 'pending'),
    );
    const blocked = resumeBlockReason(existing.state, remainingIds.length);
    if (blocked) return rejectWithValue(blocked);

    const duration = windowMinutes(existing) || 120;
    const windowStart = nowDateTime();
    const windowEnd = endTimeOf(windowStart, duration);

    let members = existing.members;
    let machines = existing.machines;
    if (mode === 'recheck') {
      const occupied = occupiedResources(
        { id: existing.id, windowStart, windowEnd },
        state.workOrders.map((item) => ({
          id: item.id,
          code: item.code,
          state: item.state,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
          machines: item.machines,
        })),
      );
      members = pickFreeResources(existing.members, MEMBER_LIBRARY, occupied.members);
      machines = pickFreeResources(existing.machines, MACHINE_LIBRARY, occupied.machines);
    }
    return {
      sourceOrderId: existing.id,
      sourceCode: existing.code,
      mode,
      faultIds: remainingIds,
      windowStart,
      windowEnd,
      leader: existing.leader,
      members,
      machines,
    };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '生成恢复草稿失败');
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
    clearResumeDraft(state) {
      state.resumeDraft = null;
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
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
        // 来源暂停单被删除后，未保存的恢复草稿一并失效
        if (
          state.resumeDraft &&
          !action.payload.workOrders.some((item) => item.id === state.resumeDraft?.sourceOrderId)
        ) {
          state.resumeDraft = null;
        }
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      })
      .addCase(createWorkOrder.fulfilled, (state) => {
        state.resumeDraft = null;
      })
      .addCase(prepareResumeDraft.fulfilled, (state, action) => {
        state.resumeDraft = action.payload;
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection, clearResumeDraft } =
  workOrderSlice.actions;
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
      const others = holdsResources(order.state)
        ? workOrders.filter((item) => item.id !== order.id && holdsResources(item.state))
        : [];
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
        solvedFaultCount: related.filter((item) => item.state === 'solved').length,
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

/** 天窗占用统计（已暂停 / 已完成的单已释放资源，不计入占用时长） */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
  pausedCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views
    .filter((item) => holdsResources(item.state))
    .reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
    pausedCount: views.filter((item) => item.state === 'paused').length,
  };
}
