/** 天窗时间窗重叠检测、可用时长计算与人员机具占用校验 */
import type { WorkOrderState } from '../types/workOrder';

export interface TimeWindow {
  /** 时间窗起 yyyy-MM-dd HH:mm */
  windowStart: string;
  /** 时间窗止 yyyy-MM-dd HH:mm */
  windowEnd: string;
}

/**
 * 仍占用人员机具的作业单状态。
 * 已暂停（登记暂停即释放资源）与已完成（作业结束）的单不再占用，
 * 冲突校验与「按当前空闲重查」都以该口径过滤。
 */
export const RESOURCE_HOLDING_STATES: WorkOrderState[] = ['planned', 'issued', 'working'];

/** 该状态的作业单是否仍占用人员机具 */
export function holdsResources(state: WorkOrderState): boolean {
  return RESOURCE_HOLDING_STATES.includes(state);
}

/** "yyyy-MM-dd HH:mm" 解析为时间戳 */
export function parseDateTime(value: string): number {
  if (!value) return Number.NaN;
  const normalized = value.length <= 10 ? `${value}T00:00:00` : value.replace(' ', 'T');
  return new Date(normalized).getTime();
}

/** 时间窗时长（分钟），非法或负值返回 0 */
export function windowMinutes(window: TimeWindow): number {
  const start = parseDateTime(window.windowStart);
  const end = parseDateTime(window.windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const diff = Math.round((end - start) / 60000);
  return diff > 0 ? diff : 0;
}

/** 时长格式化：分钟 → x 小时 y 分钟 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 两个时间窗是否重叠（首尾相接不算重叠） */
export function isOverlap(a: TimeWindow, b: TimeWindow): boolean {
  const aStart = parseDateTime(a.windowStart);
  const aEnd = parseDateTime(a.windowEnd);
  const bStart = parseDateTime(b.windowStart);
  const bEnd = parseDateTime(b.windowEnd);
  if ([aStart, aEnd, bStart, bEnd].some((value) => Number.isNaN(value))) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** 找出与目标时间窗冲突的其它作业单 */
export function findConflicts<T extends TimeWindow & { id: string; code: string }>(
  target: TimeWindow & { id: string },
  others: T[],
): T[] {
  return others.filter((item) => item.id !== target.id && isOverlap(target, item));
}

/** 人员占用冲突：同一时间窗内同一作业人员被重复排班 */
export function findMemberConflicts(
  target: TimeWindow & { id: string; members: string[] },
  others: Array<TimeWindow & { id: string; code: string; members: string[] }>,
): string[] {
  const conflicts = new Set<string>();
  for (const other of others) {
    if (other.id === target.id) continue;
    if (!isOverlap(target, other)) continue;
    for (const member of target.members) {
      if (other.members.includes(member)) conflicts.add(member);
    }
  }
  return [...conflicts];
}

/** 机具占用冲突 */
export function findMachineConflicts(
  target: TimeWindow & { id: string; machines: string[] },
  others: Array<TimeWindow & { id: string; code: string; machines: string[] }>,
): string[] {
  const conflicts = new Set<string>();
  for (const other of others) {
    if (other.id === target.id) continue;
    if (!isOverlap(target, other)) continue;
    for (const machine of target.machines) {
      if (other.machines.includes(machine)) conflicts.add(machine);
    }
  }
  return [...conflicts];
}

export interface OccupiedResources {
  /** 时间窗内被其它在办单占用的人员 */
  members: string[];
  /** 时间窗内被其它在办单占用的机具 */
  machines: string[];
  /** 占用来源作业单编号 */
  orderCodes: string[];
}

/**
 * 按当前空闲重查：统计指定时间窗内仍被在办单（待编排/已下达/作业中）占用的人员与机具。
 * 已暂停、已完成的单已释放资源，不计入占用。
 */
export function occupiedResources(
  target: TimeWindow & { id: string },
  orders: Array<
    TimeWindow & { id: string; code: string; state: WorkOrderState; members: string[]; machines: string[] }
  >,
): OccupiedResources {
  const members = new Set<string>();
  const machines = new Set<string>();
  const orderCodes = new Set<string>();
  for (const order of orders) {
    if (order.id === target.id) continue;
    if (!holdsResources(order.state)) continue;
    if (!isOverlap(target, order)) continue;
    let hit = false;
    for (const member of order.members) {
      members.add(member);
      hit = true;
    }
    for (const machine of order.machines) {
      machines.add(machine);
      hit = true;
    }
    if (hit) orderCodes.add(order.code);
  }
  return { members: [...members], machines: [...machines], orderCodes: [...orderCodes] };
}

/**
 * 天窗可用时长占比（%）：当日全部作业单占用时长 / 当日可用天窗基准（默认 180 分钟）
 */
export function occupationRate(orders: TimeWindow[], dailyBaseMinutes = 180): number {
  if (orders.length === 0) return 0;
  const total = orders.reduce((sum, item) => sum + windowMinutes(item), 0);
  if (dailyBaseMinutes <= 0) return 0;
  return Number(((total / dailyBaseMinutes) * 100).toFixed(1));
}

/** 由起始时间与时长生成结束时间字符串 */
export function endTimeOf(start: string, minutes: number): string {
  const at = parseDateTime(start);
  if (Number.isNaN(at)) return start;
  const date = new Date(at + minutes * 60000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** 当前时间字符串 */
export function nowDateTime(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(
    now.getMinutes(),
  )}`;
}

/** 今天日期 */
export function todayDate(now: Date = new Date()): string {
  return nowDateTime(now).slice(0, 10);
}

/** 日期偏移 */
export function shiftDate(days: number, from: Date = new Date()): string {
  const date = new Date(from.getTime());
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 时间窗口文案 */
export function windowText(window: TimeWindow): string {
  return `${window.windowStart} ~ ${window.windowEnd.slice(-5)}`;
}
