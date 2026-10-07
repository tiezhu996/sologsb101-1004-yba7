/**
 * /progress 作业进度与销号回写
 * 按天窗批次更新作业状态，完成项自动回写病害销号；
 * 作业中可登记暂停（原因 + 时间 + 已处理病害销号，随后释放人员机具），
 * 已暂停单恢复时人员机具二选一，只带剩余病害生成草稿；
 * 消费 WorkOrder、Fault、Inspection 与 <FilterBar>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ReplayIcon from '@mui/icons-material/Replay';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import DownloadIcon from '@mui/icons-material/Download';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  advanceWorkOrder,
  pauseWorkOrder,
  pickFreeResources,
  prepareResumeDraft,
  selectWindowStats,
  selectWorkOrderViews,
} from '../stores/workOrderStore';
import { selectFaultViews } from '../stores/faultStore';
import {
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  RESUME_MODE_LABEL,
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  pauseBlockReason,
  resumeBlockReason,
  type ResumeMode,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import { FAULT_PART_LABEL, FAULT_SEVERITY_LABEL, FAULT_TYPE_LABEL } from '../types/fault';
import { ROUTES } from '../router/routes';
import { endTimeOf, formatDuration, nowDateTime, occupiedResources } from '../utils/window';
import { downloadCsv, share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

const STATE_ORDER: WorkOrderState[] = ['planned', 'issued', 'working', 'paused', 'done'];

interface PauseDialogState {
  order: WorkOrderView;
  reason: string;
  pausedAt: string;
  solvedIds: string[];
}

interface ResumeDialogState {
  order: WorkOrderView;
  mode: ResumeMode;
}

export default function ProgressView() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const faults = useAppSelector(selectFaultViews);
  const stats = useAppSelector(selectWindowStats);
  const rawOrders = useAppSelector((state) => state.workOrder.workOrders);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['state', 'yard']);
  const [toast, setToast] = useState('');
  const [pauseDialog, setPauseDialog] = useState<PauseDialogState | null>(null);
  const [resumeDialog, setResumeDialog] = useState<ResumeDialogState | null>(null);

  const rows = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const stateFilter = (filters.state ?? []) as WorkOrderState[];
    const yardFilter = filters.yard ?? [];
    return orders
      .filter((order) => {
        if (stateFilter.length > 0 && !stateFilter.includes(order.state)) return false;
        if (yardFilter.length > 0 && !order.yardNames.some((name) => yardFilter.includes(name))) return false;
        if (lower && !`${order.code} ${order.leader} ${order.faultLabels.join(' ')}`.toLowerCase().includes(lower)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const byState = STATE_ORDER.indexOf(b.state) - STATE_ORDER.indexOf(a.state);
        if (byState !== 0) return byState;
        return a.windowStart.localeCompare(b.windowStart);
      });
  }, [orders, keyword, filters]);

  const overview = useMemo(() => {
    const done = orders.filter((item) => item.state === 'done').length;
    const working = orders.filter((item) => item.state === 'working').length;
    const issued = orders.filter((item) => item.state === 'issued').length;
    const planned = orders.filter((item) => item.state === 'planned').length;
    const paused = orders.filter((item) => item.state === 'paused').length;
    const pendingFaults = faults.filter((item) => item.state === 'pending').length;
    const solvedFaults = faults.filter((item) => item.state === 'solved').length;
    return {
      done,
      working,
      issued,
      planned,
      paused,
      pendingFaults,
      solvedFaults,
      completion: orders.length === 0 ? 0 : Number(((done / orders.length) * 100).toFixed(1)),
      solveRate: faults.length === 0 ? 0 : Number(((solvedFaults / faults.length) * 100).toFixed(1)),
    };
  }, [orders, faults]);

  /** 暂停对话框内：该单仍可销号的待修病害 */
  const pausePendingFaults = useMemo(() => {
    if (!pauseDialog) return [];
    return faults.filter((item) => pauseDialog.order.faultIds.includes(item.id) && item.state === 'pending');
  }, [pauseDialog, faults]);

  /** 恢复对话框内：按当前窗口重查占用，预览两种模式的取舍结果 */
  const resumePreview = useMemo(() => {
    if (!resumeDialog) return null;
    const order = resumeDialog.order;
    const start = nowDateTime();
    const end = endTimeOf(start, order.durationMinutes || 120);
    const occupied = occupiedResources(
      { id: order.id, windowStart: start, windowEnd: end },
      rawOrders.map((item) => ({
        id: item.id,
        code: item.code,
        state: item.state,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        members: item.members,
        machines: item.machines,
      })),
    );
    return {
      occupied,
      recheckMembers: pickFreeResources(order.members, MEMBER_LIBRARY, occupied.members),
      recheckMachines: pickFreeResources(order.machines, MACHINE_LIBRARY, occupied.machines),
      busyMembers: order.members.filter((name) => occupied.members.includes(name)),
      busyMachines: order.machines.filter((name) => occupied.machines.includes(name)),
    };
  }, [resumeDialog, rawOrders]);

  const advance = async (id: string, next: WorkOrderState, code: string): Promise<void> => {
    try {
      const result = await dispatch(advanceWorkOrder({ id, next })).unwrap();
      if (next === 'done') {
        setToast(`${code} 已完成，回写销号 ${result.solvedCount} 处病害`);
      } else {
        setToast(`${code} 已推进为「${WORK_ORDER_STATE_LABEL[next]}」`);
      }
    } catch (error) {
      setToast(`推进失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const confirmPause = async (): Promise<void> => {
    if (!pauseDialog) return;
    try {
      const result = await dispatch(
        pauseWorkOrder({
          id: pauseDialog.order.id,
          reason: pauseDialog.reason,
          pausedAt: pauseDialog.pausedAt,
          solvedFaultIds: pauseDialog.solvedIds,
        }),
      ).unwrap();
      setToast(
        `${pauseDialog.order.code} 已暂停：销掉已处理病害 ${result.solvedCount} 处，人员机具已释放`,
      );
      setPauseDialog(null);
    } catch (error) {
      setToast(`暂停失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const confirmResume = async (): Promise<void> => {
    if (!resumeDialog) return;
    try {
      const draft = await dispatch(
        prepareResumeDraft({ id: resumeDialog.order.id, mode: resumeDialog.mode }),
      ).unwrap();
      setToast(
        `已按「${RESUME_MODE_LABEL[resumeDialog.mode]}」生成恢复草稿：剩余病害 ${draft.faultIds.length} 处，请在编排台确认成单`,
      );
      setResumeDialog(null);
      navigate(ROUTES.workorders);
    } catch (error) {
      setToast(`恢复失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const exportCsv = (): void => {
    const header = ['作业单', '状态', '天窗起', '天窗止', '时长(分钟)', '负责人', '作业人员', '机具', '关联病害', '待销号', '暂停原因', '暂停时间', '冲突'];
    const body = rows.map((order) => [
      order.code,
      WORK_ORDER_STATE_LABEL[order.state],
      order.windowStart,
      order.windowEnd,
      order.durationMinutes,
      order.leader,
      order.members.join(' '),
      order.machines.join(' '),
      order.faultIds.length,
      order.pendingFaultCount,
      order.pauseReason ?? '',
      order.pausedAt ?? '',
      order.conflict ? order.conflictCodes.join(' ') : '无',
    ]);
    downloadCsv(`gbrailswitch-progress-${nowDateTime().slice(0, 10)}.csv`, [header, ...body]);
    setToast('进度清单已导出 CSV');
  };

  const availableYards = useMemo(() => [...new Set(orders.flatMap((item) => item.yardNames))], [orders]);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            作业进度与销号回写
          </Typography>
          <Typography variant="body2" color="text.secondary">
            按天窗批次推进状态：待编排 → 已下达 → 作业中 → 已完成；推进到已完成时自动回写关联病害销号。
            中途遇故障可登记暂停，销掉已处理病害后释放人员机具，恢复时只带剩余病害生成新草稿。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv}>
            导出进度 CSV
          </Button>
          <Button variant="outlined" onClick={() => navigate(ROUTES.workorders)}>
            回编排台
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="作业完成率"
            value={overview.completion}
            suffix="%"
            percent={overview.completion}
            color="#2e7d32"
            hint={`已完成 ${overview.done} / 共 ${orders.length} 张`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="在办作业单"
            value={overview.working + overview.issued}
            suffix="张"
            color="#1565c0"
            hint={`已下达 ${overview.issued} · 作业中 ${overview.working} · 已暂停 ${overview.paused} · 待编排 ${overview.planned}`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="病害销号率"
            value={overview.solveRate}
            suffix="%"
            percent={overview.solveRate}
            color="#00897b"
            hint={`已销号 ${overview.solvedFaults} 处 · 待修 ${overview.pendingFaults} 处`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="累计天窗时长"
            value={stats.minutes}
            suffix="分钟"
            color="#ed6c02"
            hint={`占用率 ${stats.occupationRate}%（基准 180 分钟/日，已暂停单不计）`}
          />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按作业单号 / 负责人 / 病害搜索"
        selects={[
          {
            key: 'state',
            label: '作业状态',
            options: STATE_ORDER.map((item) => ({ label: WORK_ORDER_STATE_LABEL[item], value: item })),
            width: 180,
          },
          {
            key: 'yard',
            label: '涉及站场',
            options: availableYards.map((name) => ({ label: name, value: name })),
            width: 190,
          },
        ]}
        resultCount={rows.length}
        countUnit="张作业单"
      />

      <Box mt={1.75}>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的作业单"
            description="可到编排台新建作业单，或调整筛选条件。"
            extra={
              <Button variant="contained" onClick={() => navigate(ROUTES.workorders)}>
                去天窗编排
              </Button>
            }
          />
        ) : (
          <Stack spacing={1.5}>
            {rows.map((order) => {
              const totalFaults = order.faultIds.length;
              const handledPercent =
                totalFaults === 0 ? 0 : Math.round((order.solvedFaultCount / totalFaults) * 100);
              const progressPercent =
                order.state === 'done'
                  ? 100
                  : order.state === 'paused'
                    ? handledPercent
                    : order.state === 'working'
                      ? 60
                      : order.state === 'issued'
                        ? 30
                        : 10;
              const nextStates = WORK_ORDER_STATE_FLOW[order.state];
              const relatedFaults = faults.filter((item) => order.faultIds.includes(item.id));
              const pauseBlocked = pauseBlockReason(order.state, order.pendingFaultCount);
              const resumeBlocked = resumeBlockReason(order.state, order.pendingFaultCount);
              return (
                <Paper key={order.id} variant="outlined" sx={{ borderRadius: 2, p: 1.75 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle1" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip
                          size="small"
                          color={
                            order.state === 'done'
                              ? 'success'
                              : order.state === 'working'
                                ? 'info'
                                : order.state === 'paused'
                                  ? 'warning'
                                  : 'default'
                          }
                          label={WORK_ORDER_STATE_LABEL[order.state]}
                        />
                        {order.conflict ? (
                          <Tooltip title={`与 ${order.conflictCodes.join('、')} 时间窗重叠`}>
                            <Chip size="small" color="error" label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        <Chip size="small" variant="outlined" label={`负责人 ${order.leader}`} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        天窗 {order.windowStart} ~ {order.windowEnd}（{formatDuration(order.durationMinutes)}）· 涉及站场{' '}
                        {order.yardNames.join('、') || '—'}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {nextStates.map((next) => (
                        <Button
                          key={next}
                          size="small"
                          variant={next === 'done' ? 'contained' : 'outlined'}
                          color={next === 'done' ? 'success' : 'primary'}
                          startIcon={next === 'done' ? <AssignmentTurnedInIcon /> : <PlayArrowIcon />}
                          onClick={() => void advance(order.id, next, order.code)}
                        >
                          推进为{WORK_ORDER_STATE_LABEL[next]}
                        </Button>
                      ))}
                      {order.state !== 'done' && order.state !== 'paused' ? (
                        <Tooltip
                          title={pauseBlocked ?? '登记暂停原因与时间，销掉已处理病害后释放人员机具'}
                        >
                          <span>
                            <Button
                              size="small"
                              variant="outlined"
                              color="warning"
                              startIcon={<PauseIcon />}
                              disabled={pauseBlocked !== null}
                              onClick={() =>
                                setPauseDialog({ order, reason: '', pausedAt: nowDateTime(), solvedIds: [] })
                              }
                            >
                              暂停
                            </Button>
                          </span>
                        </Tooltip>
                      ) : null}
                      {order.state === 'paused' ? (
                        <Tooltip title={resumeBlocked ?? '人员机具二选一，只带剩余病害生成恢复草稿'}>
                          <span>
                            <Button
                              size="small"
                              variant="contained"
                              color="warning"
                              startIcon={<ReplayIcon />}
                              disabled={resumeBlocked !== null}
                              onClick={() => setResumeDialog({ order, mode: 'recheck' })}
                            >
                              恢复
                            </Button>
                          </span>
                        </Tooltip>
                      ) : null}
                      {order.state === 'done' ? (
                        <Chip icon={<CheckCircleIcon />} color="success" label="已完成并回写销号" />
                      ) : null}
                    </Stack>
                  </Stack>

                  {order.state === 'paused' ? (
                    <Alert severity="warning" icon={<PauseIcon />} sx={{ mt: 1 }}>
                      暂停原因：{order.pauseReason ?? '—'} · 暂停于 {order.pausedAt ?? '—'} · 处理进度：已销号{' '}
                      {order.solvedFaultCount}/{totalFaults} 处 · 人员机具已释放，剩余 {order.pendingFaultCount}{' '}
                      处病害待恢复编排
                    </Alert>
                  ) : null}

                  <Box mt={1.25}>
                    <LinearProgress
                      variant="determinate"
                      value={progressPercent}
                      sx={{ height: 8, borderRadius: 4 }}
                      color={order.state === 'done' ? 'success' : order.state === 'paused' ? 'warning' : 'primary'}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {order.state === 'paused'
                        ? `处理进度 ${progressPercent}%（已销号 ${order.solvedFaultCount}/${totalFaults} 处）`
                        : `进度 ${progressPercent}% · 关联病害 ${totalFaults} 处（待销号 ${order.pendingFaultCount}）`}
                      {' '}· 作业人员 {order.members.join('、')} · 机具 {order.machines.join('、')}
                    </Typography>
                  </Box>

                  <TableContainer sx={{ mt: 1 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>关联病害</TableCell>
                          <TableCell>部件 / 类型</TableCell>
                          <TableCell>等级</TableCell>
                          <TableCell>巡检日期</TableCell>
                          <TableCell>销号状态</TableCell>
                          <TableCell>销号时间</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {relatedFaults.map((fault) => (
                          <TableRow key={fault.id} hover>
                            <TableCell>
                              {fault.yardName} · {fault.switchCode}
                            </TableCell>
                            <TableCell>
                              {fault.part} / {fault.type}
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                label={FAULT_SEVERITY_LABEL[fault.severity]}
                                sx={{
                                  backgroundColor: `${SEVERITY_HEX[fault.severity]}1a`,
                                  color: SEVERITY_HEX[fault.severity],
                                }}
                              />
                            </TableCell>
                            <TableCell>{fault.inspectionDate}</TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                variant="outlined"
                                color={fault.state === 'solved' ? 'success' : 'warning'}
                                label={fault.state === 'solved' ? '已销号' : '待修'}
                              />
                            </TableCell>
                            <TableCell>{fault.solvedAt ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                        {relatedFaults.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} align="center">
                              <Typography variant="caption" color="text.secondary">
                                关联病害已被删除或尚未加载
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>

      {/* 登记暂停 */}
      <Dialog open={pauseDialog !== null} onClose={() => setPauseDialog(null)} fullWidth maxWidth="sm">
        <DialogTitle>登记暂停 — {pauseDialog?.order.code}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={0.5}>
            <TextField
              label="暂停原因"
              required
              multiline
              minRows={2}
              value={pauseDialog?.reason ?? ''}
              onChange={(event) =>
                setPauseDialog((prev) => (prev ? { ...prev, reason: event.target.value } : prev))
              }
              placeholder="如：机具故障、天气突变、临时接车"
            />
            <TextField
              label="暂停时间"
              type="datetime-local"
              size="small"
              InputLabelProps={{ shrink: true }}
              value={(pauseDialog?.pausedAt ?? '').replace(' ', 'T')}
              onChange={(event) =>
                setPauseDialog((prev) =>
                  prev ? { ...prev, pausedAt: event.target.value.replace('T', ' ') } : prev,
                )
              }
            />
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                已处理病害（勾选后随暂停销号）
              </Typography>
              {pausePendingFaults.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  该单暂无待销号病害
                </Typography>
              ) : (
                pausePendingFaults.map((fault) => (
                  <Stack key={fault.id} direction="row" alignItems="center" spacing={0.5}>
                    <Checkbox
                      size="small"
                      checked={pauseDialog?.solvedIds.includes(fault.id) ?? false}
                      onChange={() =>
                        setPauseDialog((prev) =>
                          prev
                            ? {
                                ...prev,
                                solvedIds: prev.solvedIds.includes(fault.id)
                                  ? prev.solvedIds.filter((id) => id !== fault.id)
                                  : [...prev.solvedIds, fault.id],
                              }
                            : prev,
                        )
                      }
                    />
                    <Typography variant="body2" sx={{ flexGrow: 1 }}>
                      {fault.yardName} · {fault.switchCode} · {FAULT_PART_LABEL[fault.part]} /{' '}
                      {FAULT_TYPE_LABEL[fault.type]}
                    </Typography>
                    <Chip
                      size="small"
                      label={FAULT_SEVERITY_LABEL[fault.severity]}
                      sx={{
                        backgroundColor: `${SEVERITY_HEX[fault.severity]}1a`,
                        color: SEVERITY_HEX[fault.severity],
                      }}
                    />
                  </Stack>
                ))
              )}
            </Box>
            <Alert severity="info">
              确认后：勾选病害按暂停时间销号，人员机具立即释放（不再参与占用校验），剩余病害待恢复时重新编排。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPauseDialog(null)}>取消</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!pauseDialog?.reason.trim()}
            onClick={() => void confirmPause()}
          >
            确认暂停
          </Button>
        </DialogActions>
      </Dialog>

      {/* 恢复作业：人员机具二选一 */}
      <Dialog open={resumeDialog !== null} onClose={() => setResumeDialog(null)} fullWidth maxWidth="sm">
        <DialogTitle>恢复作业 — {resumeDialog?.order.code}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={0.5}>
            <Alert severity="info">
              恢复后只带剩余病害生成草稿：剩余 {resumeDialog?.order.pendingFaultCount ?? 0} 处（已处理{' '}
              {resumeDialog?.order.solvedFaultCount ?? 0} 处留在原暂停单作记录）。
            </Alert>
            <RadioGroup
              value={resumeDialog?.mode ?? 'recheck'}
              onChange={(event) =>
                setResumeDialog((prev) =>
                  prev ? { ...prev, mode: event.target.value as ResumeMode } : prev,
                )
              }
            >
              <FormControlLabel value="recheck" control={<Radio />} label={RESUME_MODE_LABEL.recheck} />
              <Typography variant="caption" color="text.secondary" sx={{ ml: 4, mt: -1 }}>
                重新查询当前空闲的人员机具，已被别的单占用的按字典顺序替换补齐
              </Typography>
              <FormControlLabel value="reuse" control={<Radio />} label={RESUME_MODE_LABEL.reuse} />
              <Typography variant="caption" color="text.secondary" sx={{ ml: 4, mt: -1 }}>
                保留暂停前的人员机具；若沿用旧安排，会把已被别的单占用的资源当成可用
              </Typography>
            </RadioGroup>
            {resumeDialog?.mode === 'recheck' && resumePreview ? (
              <Alert severity="success">
                重查结果：人员 {resumePreview.recheckMembers.join('、') || '—'} · 机具{' '}
                {resumePreview.recheckMachines.join('、') || '—'}
                {resumePreview.occupied.orderCodes.length > 0
                  ? `（已剔除被 ${resumePreview.occupied.orderCodes.join('、')} 占用的资源）`
                  : '（当前时间窗无占用冲突）'}
              </Alert>
            ) : null}
            {resumeDialog?.mode === 'reuse' && resumePreview ? (
              resumePreview.busyMembers.length > 0 || resumePreview.busyMachines.length > 0 ? (
                <Alert severity="warning">
                  以下资源当前已被 {resumePreview.occupied.orderCodes.join('、')} 占用，沿用将产生占用冲突：人员{' '}
                  {resumePreview.busyMembers.join('、') || '无'} · 机具 {resumePreview.busyMachines.join('、') || '无'}
                </Alert>
              ) : (
                <Alert severity="success">旧安排的人员机具当前均空闲，可直接沿用。</Alert>
              )
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResumeDialog(null)}>取消</Button>
          <Button variant="contained" color="warning" onClick={() => void confirmResume()}>
            生成恢复草稿
          </Button>
        </DialogActions>
      </Dialog>

      <Alert severity="info" sx={{ mt: 2 }}>
        说明：天窗作业单推进到「已完成」时，系统会把该单关联的全部待修病害一次性置为已销号并记录销号时间；
        中途遇故障可「暂停」——登记原因与时间、销掉已处理病害并释放人员机具，恢复时只带剩余病害生成新草稿，
        可在「病害评定与销号」页撤销销号。
      </Alert>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2800}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      <Typography variant="caption" color="text.secondary" display="block" mt={1}>
        当前时间基准 {nowDateTime()} · 销号率 {share(overview.solvedFaults, faults.length)}%
      </Typography>
    </Box>
  );
}
