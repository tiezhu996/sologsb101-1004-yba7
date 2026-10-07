import type { Revisioned } from './persistence';

/** 天窗作业单状态 */
export type WorkOrderState = 'planned' | 'issued' | 'working' | 'paused' | 'done';

export const WORK_ORDER_STATE_LABEL: Record<WorkOrderState, string> = {
  planned: '待编排',
  issued: '已下达',
  working: '作业中',
  paused: '已暂停',
  done: '已完成',
};

/**
 * 作业单状态流转（前进方向）。
 * 暂停不走通用推进：由「登记暂停」专用动作从 已下达/作业中 切入；
 * 已暂停单不直接回流转，恢复时以剩余病害生成新草稿单。
 */
export const WORK_ORDER_STATE_FLOW: Record<WorkOrderState, WorkOrderState[]> = {
  planned: ['issued'],
  issued: ['working'],
  working: ['done'],
  paused: [],
  done: [],
};

/** 天窗作业单 */
export interface WorkOrder extends Revisioned {
  id: string;
  /** 作业单编号，如 TW-20260824-01 */
  code: string;
  /** 关联病害 id 列表 */
  faultIds: string[];
  /** 天窗起 yyyy-MM-dd HH:mm */
  windowStart: string;
  /** 天窗止 yyyy-MM-dd HH:mm */
  windowEnd: string;
  /** 负责人 */
  leader: string;
  /** 机具清单 */
  machines: string[];
  /** 作业人员 */
  members: string[];
  /** 状态 */
  state: WorkOrderState;
  /** 暂停原因（未暂停为 null） */
  pauseReason: string | null;
  /** 暂停登记时间 yyyy-MM-dd HH:mm（未暂停为 null） */
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 作业单表单草稿 */
export interface WorkOrderDraft {
  code: string;
  faultIds: string[];
  windowStart: string;
  windowEnd: string;
  leader: string;
  machines: string[];
  members: string[];
}

/** 作业单视图：带病害明细与时间窗指标 */
export interface WorkOrderView extends WorkOrder {
  /** 关联病害的展示标签 */
  faultLabels: string[];
  /** 涉及站场 */
  yardNames: string[];
  /** 天窗时长（分钟） */
  durationMinutes: number;
  /** 是否与其它作业单时间窗冲突 */
  conflict: boolean;
  /** 冲突的作业单编号 */
  conflictCodes: string[];
  /** 人员占用冲突 */
  memberConflict: boolean;
  /** 机具占用冲突 */
  machineConflict: boolean;
  /** 关联病害中仍未销号的数量 */
  pendingFaultCount: number;
  /** 关联病害中已销号（已处理）的数量 */
  solvedFaultCount: number;
}

/** 恢复时人员机具的取舍模式（二选一） */
export type ResumeMode = 'recheck' | 'reuse';

export const RESUME_MODE_LABEL: Record<ResumeMode, string> = {
  recheck: '按当前空闲重查',
  reuse: '沿用旧安排',
};

/** 恢复草稿：从暂停单带出剩余病害与人员机具，跳到编排台确认成单 */
export interface ResumeDraft {
  /** 来源暂停单 id（保存草稿时把剩余病害从该单摘出） */
  sourceOrderId: string;
  /** 来源暂停单编号（展示用） */
  sourceCode: string;
  /** 人员机具取舍模式 */
  mode: ResumeMode;
  /** 仅剩余（未销号）病害 */
  faultIds: string[];
  windowStart: string;
  windowEnd: string;
  leader: string;
  machines: string[];
  members: string[];
}

/**
 * 不能暂停的原因；返回 null 表示可以暂停。
 * 已完成、未下达（待编排）或无剩余病害的单不能暂停。
 */
export function pauseBlockReason(state: WorkOrderState, pendingFaultCount: number): string | null {
  if (state === 'done') return '已完成的单不能暂停';
  if (state === 'planned') return '未下达的单不能暂停';
  if (state === 'paused') return '该单已处于暂停状态';
  if (pendingFaultCount <= 0) return '无剩余病害的单不能暂停';
  return null;
}

/** 不能恢复的原因；仅已暂停且仍有剩余病害的单可以恢复 */
export function resumeBlockReason(state: WorkOrderState, pendingFaultCount: number): string | null {
  if (state !== 'paused') return '仅已暂停的单可以恢复';
  if (pendingFaultCount <= 0) return '无剩余病害，无需恢复';
  return null;
}

/** 常用机具字典 */
export const MACHINE_LIBRARY: string[] = [
  '轨距尺',
  '道尺',
  '起道机',
  '捣固镐',
  '钢轨打磨机',
  '扭矩扳手',
  '辙叉吊具',
  '发电机',
  '照明灯组',
  '转辙机专用工具',
];

/** 常用作业人员 */
export const MEMBER_LIBRARY: string[] = [
  '赵铁军',
  '孙立波',
  '周振海',
  '吴长胜',
  '郑小勇',
  '韩学斌',
  '冯国栋',
];

/** 作业单编号生成 */
export function buildWorkOrderCode(date: Date, seq: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `TW-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(seq)}`;
}
