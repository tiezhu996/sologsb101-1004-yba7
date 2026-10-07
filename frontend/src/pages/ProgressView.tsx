/**
 * /progress 作业进度与销号回写
 * 按天窗批次更新作业状态，完成项自动回写病害销号；
 * 作业中可登记暂停原因 / 时间并释放人员机具，恢复时「按当前空闲重查」或「沿用旧安排」二选一；
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
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  LinearProgress,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Paper,
  Radio,
  RadioGroup,
  Select,
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
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import DownloadIcon from '@mui/icons-material/Download';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import { store as appStore } from '../stores';
import {
  advanceWorkOrder,
  pauseWorkOrder,
  resumeWorkOrder,
  selectResumeAvailability,
  selectWindowStats,
  selectWorkOrderViews,
} from '../stores/workOrderStore';
import { selectFaultViews } from '../stores/faultStore';
import {
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  PAUSE_REASON_LIBRARY,
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  type WorkOrderResumeMode,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL, type FaultView } from '../types/fault';
import { ROUTES } from '../router/routes';
import { endTimeOf, formatDuration, nowDateTime, windowMinutes } from '../utils/window';
import { downloadCsv, share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

const STATE_ORDER: WorkOrderState[] = ['planned', 'issued', 'working', 'paused', 'done'];

interface PauseDialogState {
  open: boolean;
  order: WorkOrderView | null;
  reason: string;
  customReason: string;
  pausedAt: string;
  solvedFaultIds: string[];
}

interface ResumeDialogState {
  open: boolean;
  order: WorkOrderView | null;
  mode: WorkOrderResumeMode;
  windowStart: string;
  windowEnd: string;
  leader: string;
  members: string[];
  machines: string[];
}

function emptyPauseDialog(): PauseDialogState {
  return { open: false, order: null, reason: '', customReason: '', pausedAt: nowDateTime(), solvedFaultIds: [] };
}

export default function ProgressView() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const faults = useAppSelector(selectFaultViews);
  const stats = useAppSelector(selectWindowStats);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['state', 'yard']);
  const [toast, setToast] = useState('');
  const [pauseDialog, setPauseDialog] = useState<PauseDialogState>(emptyPauseDialog);
  const [resumeDialog, setResumeDialog] = useState<ResumeDialogState>({
    open: false,
    order: null,
    mode: 'recheck',
    windowStart: nowDateTime(),
    windowEnd: endTimeOf(nowDateTime(), 120),
    leader: '',
    members: [],
    machines: [],
  });

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
    const paused = orders.filter((item) => item.state === 'paused').length;
    const issued = orders.filter((item) => item.state === 'issued').length;
    const planned = orders.filter((item) => item.state === 'planned').length;
    const pendingFaults = faults.filter((item) => item.state === 'pending').length;
    const solvedFaults = faults.filter((item) => item.state === 'solved').length;
    return {
      done,
      working,
      paused,
      issued,
      planned,
      pendingFaults,
      solvedFaults,
      completion: orders.length === 0 ? 0 : Number(((done / orders.length) * 100).toFixed(1)),
      solveRate: faults.length === 0 ? 0 : Number(((solvedFaults / faults.length) * 100).toFixed(1)),
    };
  }, [orders, faults]);

  /** 暂停单当前关联的剩余病害（恢复草稿只带这些） */
  const resumeRemainingFaults = useMemo(() => {
    if (!resumeDialog.order) return [];
    return faults.filter((item) => resumeDialog.order?.faultIds.includes(item.id));
  }, [faults, resumeDialog.order]);

  /** 恢复弹窗：按当前空闲重查的人员 / 机具占用情况 */
  const resumeAvailability = useAppSelector((state) =>
    resumeDialog.open && resumeDialog.order
      ? selectResumeAvailability(state, resumeDialog.order.id, {
          windowStart: resumeDialog.windowStart,
          windowEnd: resumeDialog.windowEnd,
        })
      : { busyMembers: [], busyMachines: [], memberBy: {}, machineBy: {} },
  );

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

  const openPause = (order: WorkOrderView): void => {
    setPauseDialog({ open: true, order, reason: PAUSE_REASON_LIBRARY[0], customReason: '', pausedAt: nowDateTime(), solvedFaultIds: [] });
  };

  const openResume = (order: WorkOrderView): void => {
    if (order.faultIds.length === 0) {
      setToast('该单已无剩余病害，请直接归档');
      return;
    }
    // 默认沿用暂停单原排定时间窗，可在弹窗内改期；重查模式下预选值先剔除已被占用的资源
    const windowStart = order.windowStart;
    const windowEnd = order.windowEnd;
    const availability = selectResumeAvailability(
      appStore.getState(),
      order.id,
      { windowStart, windowEnd },
    );
    setResumeDialog({
      open: true,
      order,
      mode: 'recheck',
      windowStart,
      windowEnd,
      leader: order.leader,
      members: order.pausedMembers.filter((name) => !availability.busyMembers.includes(name)),
      machines: order.pausedMachines.filter((name) => !availability.busyMachines.includes(name)),
    });
  };

  const submitPause = async (): Promise<void> => {
    if (!pauseDialog.order) return;
    const reason = pauseDialog.customReason.trim() || pauseDialog.reason.trim();
    if (!reason) {
      setToast('请登记暂停原因');
      return;
    }
    if (!pauseDialog.pausedAt.trim()) {
      setToast('请填写暂停时间');
      return;
    }
    try {
      const result = await dispatch(
        pauseWorkOrder({
          id: pauseDialog.order.id,
          input: {
            reason,
            pausedAt: pauseDialog.pausedAt,
            solvedFaultIds: pauseDialog.solvedFaultIds,
          },
        }),
      ).unwrap();
      setToast(
        `${pauseDialog.order.code} 已暂停：本次销号 ${result.solvedCount} 处，释放人员机具，剩余 ${result.remainingCount} 处待恢复`,
      );
      setPauseDialog(emptyPauseDialog());
    } catch (error) {
      setToast(`暂停失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const submitResume = async (): Promise<void> => {
    if (!resumeDialog.order) return;
    try {
      await dispatch(
        resumeWorkOrder({
          id: resumeDialog.order.id,
          draft: {
            mode: resumeDialog.mode,
            windowStart: resumeDialog.windowStart,
            windowEnd: resumeDialog.windowEnd,
            leader: resumeDialog.leader,
            members: resumeDialog.members,
            machines: resumeDialog.machines,
          },
        }),
      ).unwrap();
      setToast(
        resumeDialog.mode === 'reuse'
          ? `${resumeDialog.order.code} 已恢复作业，沿用暂停前安排`
          : `${resumeDialog.order.code} 已恢复作业，人员机具已按当前空闲重查`,
      );
      setResumeDialog((prev) => ({ ...prev, open: false, order: null }));
    } catch (error) {
      setToast(`恢复失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /** 切换恢复方式：沿用旧安排时锁定为快照资源；重查时放开编辑 */
  const switchResumeMode = (mode: WorkOrderResumeMode): void => {
    setResumeDialog((prev) => {
      if (!prev.order) return prev;
      if (mode === 'reuse') {
        return { ...prev, mode, members: prev.order.pausedMembers, machines: prev.order.pausedMachines };
      }
      return { ...prev, mode };
    });
  };

  const pauseCandidates = pauseDialog.order
    ? faults.filter((item) => pauseDialog.order?.faultIds.includes(item.id) && item.state === 'pending')
    : [];

  const exportCsv = (): void => {
    const header = [
      '作业单',
      '状态',
      '天窗起',
      '天窗止',
      '时长(分钟)',
      '负责人',
      '作业人员',
      '机具',
      '关联病害',
      '已处理',
      '待销号',
      '暂停原因',
      '暂停时间',
      '冲突',
    ];
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
      order.processedFaultCount,
      order.pendingFaultCount,
      order.pausedReason ?? '',
      order.pausedAt ?? '',
      order.conflict ? order.conflictCodes.join(' ') : '无',
    ]);
    downloadCsv(`gbrailswitch-progress-${nowDateTime().slice(0, 10)}.csv`, [header, ...body]);
    setToast('进度清单已导出 CSV');
  };

  const availableYards = useMemo(() => [...new Set(orders.flatMap((item) => item.yardNames))], [orders]);

  const progressOf = (order: WorkOrderView): number => {
    if (order.state === 'done') return 100;
    if (order.totalFaultCount === 0) return order.state === 'working' ? 60 : order.state === 'issued' ? 30 : 10;
    return Math.round((order.processedFaultCount / order.totalFaultCount) * 100);
  };

  const faultLabel = (fault: FaultView): string => `${fault.yardName} · ${fault.switchCode} ${fault.part}/${fault.type}`;

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            作业进度与销号回写
          </Typography>
          <Typography variant="body2" color="text.secondary">
            按天窗批次推进状态：待编排 → 已下达 → 作业中 → 已完成；中途故障可暂停并释放人员机具，恢复时按当前空闲重排；
            推进到已完成时自动回写关联病害销号。
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
            value={overview.working + overview.issued + overview.paused}
            suffix="张"
            color="#1565c0"
            hint={`已下达 ${overview.issued} · 作业中 ${overview.working} · 暂停 ${overview.paused} · 待编排 ${overview.planned}`}
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
            hint={`占用率 ${stats.occupationRate}%（基准 180 分钟/日）`}
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
              const progressPercent = progressOf(order);
              const nextStates = WORK_ORDER_STATE_FLOW[order.state].filter(
                (next) => !(order.state === 'paused' && next === 'working'),
              );
              const relatedFaults = faults.filter((item) => order.faultIds.includes(item.id));
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
                        {order.state === 'paused' ? (
                          <Tooltip title={`暂停时间 ${order.pausedAt ?? '—'}`}>
                            <Chip size="small" color="warning" variant="outlined" label={`暂停原因：${order.pausedReason ?? '—'}`} />
                          </Tooltip>
                        ) : null}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        天窗 {order.windowStart} ~ {order.windowEnd}（{formatDuration(order.durationMinutes)}）· 涉及站场{' '}
                        {order.yardNames.join('、') || '—'}
                      </Typography>
                      {order.state === 'paused' ? (
                        <Typography variant="caption" color="warning.main" display="block" mt={0.25}>
                          暂停于 {order.pausedAt ?? '—'} · 人员机具已释放（旧安排：人员{' '}
                          {order.pausedMembers.join('、') || '—'} · 机具 {order.pausedMachines.join('、') || '—'}）
                        </Typography>
                      ) : null}
                    </Box>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {order.state === 'working' ? (
                        <Button
                          size="small"
                          color="warning"
                          variant="outlined"
                          startIcon={<PauseCircleIcon />}
                          onClick={() => openPause(order)}
                        >
                          暂停登记
                        </Button>
                      ) : null}
                      {order.state === 'paused' ? (
                        <Button
                          size="small"
                          variant="contained"
                          color="primary"
                          startIcon={<PlaylistPlayIcon />}
                          onClick={() => openResume(order)}
                        >
                          恢复作业（{order.faultIds.length} 处剩余）
                        </Button>
                      ) : null}
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
                      {order.state === 'done' ? (
                        <Chip icon={<CheckCircleIcon />} color="success" label="已完成并回写销号" />
                      ) : null}
                    </Stack>
                  </Stack>

                  <Box mt={1.25}>
                    <LinearProgress
                      variant="determinate"
                      value={progressPercent}
                      sx={{ height: 8, borderRadius: 4 }}
                      color={order.state === 'done' ? 'success' : order.state === 'paused' ? 'warning' : 'primary'}
                    />
                    <Typography variant="caption" color="text.secondary">
                      处理进度 {progressPercent}%（已处理 {order.processedFaultCount} / 共 {order.totalFaultCount}
                      处）· 待销号 {order.pendingFaultCount} · 作业人员 {order.members.join('、') || '已释放'} · 机具{' '}
                      {order.machines.join('、') || '已释放'}
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
                                {order.processedFaultIds.length > 0
                                  ? '本单病害已在暂停时全部处理销号'
                                  : '关联病害已被删除或尚未加载'}
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

      {/* 暂停登记弹窗 */}
      <Dialog open={pauseDialog.open} onClose={() => setPauseDialog(emptyPauseDialog())} fullWidth maxWidth="sm">
        <DialogTitle>暂停登记{pauseDialog.order ? ` · ${pauseDialog.order.code}` : ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Alert severity="warning">
              暂停后本单人员 / 机具立即释放供其它作业单使用；勾选的已处理病害会销号并移出本单，恢复时只带剩余病害生成草稿。
            </Alert>
            <FormControl fullWidth size="small">
              <InputLabel>暂停原因</InputLabel>
              <Select
                label="暂停原因"
                value={pauseDialog.reason}
                onChange={(event) => setPauseDialog((prev) => ({ ...prev, reason: event.target.value }))}
              >
                {PAUSE_REASON_LIBRARY.map((reason) => (
                  <MenuItem key={reason} value={reason}>
                    {reason}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              fullWidth
              size="small"
              label="暂停原因补充说明（填写后以补充说明为准）"
              multiline
              minRows={2}
              value={pauseDialog.customReason}
              placeholder="可直接填写具体故障情况，留空则使用上面选择的原因"
              onChange={(event) => setPauseDialog((prev) => ({ ...prev, customReason: event.target.value }))}
            />
            <TextField
              fullWidth
              size="small"
              type="datetime-local"
              label="暂停时间"
              InputLabelProps={{ shrink: true }}
              value={pauseDialog.pausedAt.replace(' ', 'T')}
              onChange={(event) =>
                setPauseDialog((prev) => ({ ...prev, pausedAt: event.target.value.replace('T', ' ') }))
              }
            />
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                本次已处理病害（勾选后销号并释放，剩余 {pauseCandidates.length - pauseDialog.solvedFaultIds.length} 处）
              </Typography>
              {pauseCandidates.length === 0 ? (
                <Alert severity="info">关联病害已全部处理，请直接推进为已完成，无需暂停。</Alert>
              ) : (
                <Stack>
                  {pauseCandidates.map((fault) => (
                    <FormControlLabel
                      key={fault.id}
                      control={
                        <Checkbox
                          size="small"
                          checked={pauseDialog.solvedFaultIds.includes(fault.id)}
                          onChange={(event) =>
                            setPauseDialog((prev) => ({
                              ...prev,
                              solvedFaultIds: event.target.checked
                                ? [...prev.solvedFaultIds, fault.id]
                                : prev.solvedFaultIds.filter((id) => id !== fault.id),
                            }))
                          }
                        />
                      }
                      label={`${faultLabel(fault)}（${FAULT_SEVERITY_LABEL[fault.severity]}）`}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPauseDialog(emptyPauseDialog())}>取消</Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={<PauseCircleIcon />}
            disabled={pauseCandidates.length === 0}
            onClick={() => void submitPause()}
          >
            确认暂停并释放资源
          </Button>
        </DialogActions>
      </Dialog>

      {/* 恢复作业弹窗 */}
      <Dialog open={resumeDialog.open} onClose={() => setResumeDialog((prev) => ({ ...prev, open: false }))} fullWidth maxWidth="md">
        <DialogTitle>恢复作业{resumeDialog.order ? ` · ${resumeDialog.order.code}` : ''}</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Typography variant="subtitle2" gutterBottom>
                人员机具恢复方式（二选一）
              </Typography>
              <RadioGroup
                value={resumeDialog.mode}
                onChange={(event) => switchResumeMode(event.target.value as WorkOrderResumeMode)}
              >
                <FormControlLabel
                  value="recheck"
                  control={<Radio size="small" />}
                  label="按当前空闲重查：按新时间窗实时核对人员 / 机具占用，已被别的单占用的资源不可选"
                />
                <FormControlLabel
                  value="reuse"
                  control={<Radio size="small" />}
                  label="沿用旧安排：恢复暂停前的人员机具，若已被别的单占用则拒绝恢复"
                />
              </RadioGroup>
            </Grid>

            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="新天窗起"
                InputLabelProps={{ shrink: true }}
                value={resumeDialog.windowStart.replace(' ', 'T')}
                onChange={(event) =>
                  setResumeDialog((prev) => ({
                    ...prev,
                    windowStart: event.target.value.replace('T', ' '),
                    windowEnd: endTimeOf(
                      event.target.value.replace('T', ' '),
                      windowMinutes({ windowStart: prev.windowStart, windowEnd: prev.windowEnd }) || 120,
                    ),
                  }))
                }
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="新天窗止"
                InputLabelProps={{ shrink: true }}
                value={resumeDialog.windowEnd.replace(' ', 'T')}
                onChange={(event) =>
                  setResumeDialog((prev) => ({ ...prev, windowEnd: event.target.value.replace('T', ' ') }))
                }
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>负责人</InputLabel>
                <Select
                  label="负责人"
                  value={resumeDialog.leader}
                  onChange={(event) => setResumeDialog((prev) => ({ ...prev, leader: event.target.value }))}
                >
                  {[...new Set([...MEMBER_LIBRARY, ...(resumeDialog.order?.leader ? [resumeDialog.order.leader] : [])])].map(
                    (name) => (
                      <MenuItem key={name} value={name}>
                        {name}
                      </MenuItem>
                    ),
                  )}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small" disabled={resumeDialog.mode === 'reuse'}>
                <InputLabel>作业人员</InputLabel>
                <Select
                  multiple
                  label="作业人员"
                  value={resumeDialog.members}
                  input={<OutlinedInput label="作业人员" />}
                  onChange={(event) =>
                    setResumeDialog((prev) => ({
                      ...prev,
                      members: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                    }))
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MEMBER_LIBRARY.map((name) => {
                    const busy = resumeAvailability.busyMembers.includes(name);
                    return (
                      <MenuItem key={name} value={name} disabled={busy}>
                        <Checkbox checked={resumeDialog.members.includes(name)} disabled={busy} />
                        <ListItemText
                          primary={name}
                          secondary={busy ? `占用中：${resumeAvailability.memberBy[name] ?? '其它作业单'}` : '当前空闲'}
                        />
                      </MenuItem>
                    );
                  })}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small" disabled={resumeDialog.mode === 'reuse'}>
                <InputLabel>机具清单</InputLabel>
                <Select
                  multiple
                  label="机具清单"
                  value={resumeDialog.machines}
                  input={<OutlinedInput label="机具清单" />}
                  onChange={(event) =>
                    setResumeDialog((prev) => ({
                      ...prev,
                      machines: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                    }))
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MACHINE_LIBRARY.map((name) => {
                    const busy = resumeAvailability.busyMachines.includes(name);
                    return (
                      <MenuItem key={name} value={name} disabled={busy}>
                        <Checkbox checked={resumeDialog.machines.includes(name)} disabled={busy} />
                        <ListItemText
                          primary={name}
                          secondary={busy ? `占用中：${resumeAvailability.machineBy[name] ?? '其它作业单'}` : '当前空闲'}
                        />
                      </MenuItem>
                    );
                  })}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <Alert severity={resumeDialog.mode === 'reuse' ? 'warning' : 'info'}>
                {resumeDialog.mode === 'reuse'
                  ? `沿用旧安排：人员 ${(resumeDialog.order?.pausedMembers ?? []).join('、') || '—'} · 机具 ${
                      (resumeDialog.order?.pausedMachines ?? []).join('、') || '—'
                    }；若已被别的单占用将无法恢复。`
                  : '按当前空闲重查：下拉中标注「占用中」的人员 / 机具在该时间窗已被别的单占用，不可勾选。'}
              </Alert>
            </Grid>

            <Grid item xs={12}>
              <Typography variant="subtitle2" gutterBottom>
                恢复后仅带剩余病害（{resumeRemainingFaults.length} 处）
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {resumeRemainingFaults.map((fault) => (
                  <Chip key={fault.id} size="small" label={faultLabel(fault)} sx={{ borderColor: SEVERITY_HEX[fault.severity] }} />
                ))}
                {resumeRemainingFaults.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    无剩余病害，不应恢复，请将作业单归档。
                  </Typography>
                ) : null}
              </Stack>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResumeDialog((prev) => ({ ...prev, open: false }))}>取消</Button>
          <Button variant="contained" startIcon={<PlaylistPlayIcon />} onClick={() => void submitResume()}>
            确认恢复为作业中
          </Button>
        </DialogActions>
      </Dialog>

      <Alert severity="info" sx={{ mt: 2 }}>
        说明：作业中遇故障可登记暂停原因与时间，勾选本次已处理病害后销号并释放人员机具；恢复时二选一——按当前空闲重查会实时核对占用关系，
        沿用旧安排时若资源已被别的单占用将被拦截。暂停单只保留剩余病害，推进到「已完成」时再一次性回写剩余病害销号。
      </Alert>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3200}
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
