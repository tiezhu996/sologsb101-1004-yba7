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

/** 作业单状态流转（暂停仅发生在作业中，恢复回到作业中） */
export const WORK_ORDER_STATE_FLOW: Record<WorkOrderState, WorkOrderState[]> = {
  planned: ['issued'],
  issued: ['working'],
  working: ['paused', 'done'],
  paused: ['working'],
  done: [],
};

/** 仍在占用人员 / 机具 / 时间窗的状态；已暂停（资源已释放）与已完成不占资源 */
export const RESOURCE_OCCUPYING_STATES: WorkOrderState[] = ['planned', 'issued', 'working'];

/** 常见暂停原因 */
export const PAUSE_REASON_LIBRARY: string[] = [
  '机具故障',
  '人员受伤或身体不适',
  '天气突变（暴雨 / 大风）',
  '材料备件不足',
  '调度临时变更 / 封锁提前结束',
  '发现新增病害需上报',
];

/** 天窗作业单 */
export interface WorkOrder extends Revisioned {
  id: string;
  /** 作业单编号，如 TW-20260824-01 */
  code: string;
  /** 关联病害 id 列表（暂停销号后仅保留剩余病害） */
  faultIds: string[];
  /** 天窗起 yyyy-MM-dd HH:mm */
  windowStart: string;
  /** 天窗止 yyyy-MM-dd HH:mm */
  windowEnd: string;
  /** 负责人 */
  leader: string;
  /** 机具清单（暂停期间为空，恢复时重新分配） */
  machines: string[];
  /** 作业人员（暂停期间为空，恢复时重新分配） */
  members: string[];
  /** 状态 */
  state: WorkOrderState;
  /** 暂停原因（仅暂停态有值） */
  pausedReason: string | null;
  /** 暂停登记时间 yyyy-MM-dd HH:mm */
  pausedAt: string | null;
  /** 暂停时销号并移出本单的病害 id（用于进度展示与多次暂停累计） */
  processedFaultIds: string[];
  /** 暂停时的人员机具快照，供恢复时「沿用旧安排」比对 */
  pausedMembers: string[];
  pausedMachines: string[];
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

/** 暂停入参 */
export interface WorkOrderPauseInput {
  /** 暂停前已处理（本次作业完成、需销号释放）的病害 id */
  solvedFaultIds: string[];
  /** 暂停原因 */
  reason: string;
  /** 暂停登记时间，缺省取当前时间 */
  pausedAt?: string;
}

/** 恢复方式：recheck=按当前空闲重查；reuse=沿用暂停前旧安排 */
export type WorkOrderResumeMode = 'recheck' | 'reuse';

/** 恢复草稿：只带剩余病害，重新核定时间窗与人员机具 */
export interface WorkOrderResumeDraft {
  windowStart: string;
  windowEnd: string;
  leader: string;
  members: string[];
  machines: string[];
  mode: WorkOrderResumeMode;
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
  /** 已处理病害数（暂停销号累计 + 当前剩余中已销号） */
  processedFaultCount: number;
  /** 全部纳入过本单的病害数（已处理 + 剩余） */
  totalFaultCount: number;
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
