import React, { useState, useMemo, useCallback } from 'react'
import { Activity, AlertTriangle, Eye, Users, LayoutGrid, List, Search } from 'lucide-react'
import useProctoring from '../hooks/useProctoring'
import SessionGrid from '../components/proctoring/SessionGrid'
import SearchBar from '../components/common/SearchBar'
import LiveCameraWall from '../components/proctoring/LiveCameraWall'
import SessionDetailModal from '../modal/Proctoring/SessionDetailModal'
import Badge from '../components/common/Badge'
import { useProctoringStreams } from '../hooks/useProctoringStreams'
import ActiveRosterPanel from '../components/proctoring/ActiveRosterPanel'
import useActiveProctoringRoster from '../hooks/useActiveProctoringRoster'
import type { ProctoringSession } from '../types/proctoring'
import '../styles/common.css'
import '../styles/proctoring.css'

type ViewMode = 'grid' | 'list'

export default function ProctoringPage(): JSX.Element {
	const {
		sessions,
		allSessions,
		filters,
		updateFilter,
		stats,
		exams,
		selectedSession,
		setSelectedSession,
		autoRefresh,
		setAutoRefresh,
		terminateSession,
		sendWarning,
		resolveViolation,
		loading
	} = useProctoring()

	const {
		roster: activeRoster,
		loading: rosterLoading,
		error: rosterError,
		lastFetchedAt: rosterLastFetchedAt,
		refresh: refreshRoster
	} = useActiveProctoringRoster(autoRefresh ? 15000 : 0)

	const matchesFilters = useCallback((session: ProctoringSession) => {
		const search = filters.search.trim().toLowerCase()
		if (search) {
			const matchSearch =
				session.userName.toLowerCase().includes(search) ||
				session.examTitle.toLowerCase().includes(search) ||
				session.userId.toLowerCase().includes(search)
			if (!matchSearch) {
				return false
			}
		}

		if (filters.status !== 'all' && session.status !== filters.status) {
			return false
		}

		if (filters.riskLevel !== 'all' && session.riskLevel !== filters.riskLevel) {
			return false
		}

		if (filters.examId !== 'all' && session.examId !== filters.examId) {
			return false
		}

		return true
	}, [filters])

	const streamSessions = useMemo<ProctoringSession[]>(() => {
		if (!activeRoster.length) {
			return allSessions
		}

		// Tạo map theo sessionId từ allSessions
		const sessionById = new Map<string, ProctoringSession>(
			allSessions.map(session => [session.id, session])
		)

		// Tạo map theo userId+examId để tìm session khi không có sessionId
		// Normalize userId về string để đảm bảo match
		const sessionByUserExam = new Map<string, ProctoringSession>()
		for (const session of allSessions) {
			const normalizedUserId = String(session.userId)
			const key = `${session.examId}::${normalizedUserId}`
			sessionByUserExam.set(key, session)
		}

		const merged = new Map<string, ProctoringSession>()

		// Thêm tất cả sessions hiện có vào merged
		for (const session of allSessions) {
			merged.set(session.id, session)
		}

		// Merge hoặc thêm từ roster
		for (const entry of activeRoster) {
			let existingSession: ProctoringSession | undefined

			// Ưu tiên tìm theo sessionId nếu có
			if (entry.sessionId && entry.sessionId.trim().length > 0) {
				existingSession = sessionById.get(entry.sessionId)
			}

			// Nếu không tìm thấy, thử tìm theo userId + examId
			if (!existingSession && entry.examId && entry.studentId !== null && entry.studentId !== undefined) {
				const normalizedStudentId = String(entry.studentId)
				// Skip nếu studentId không hợp lệ (là placeholder như "student")
				if (normalizedStudentId !== 'student' && normalizedStudentId !== 'unknown') {
					const key = `${entry.examId}::${normalizedStudentId}`
					existingSession = sessionByUserExam.get(key)
				}
			}

			if (existingSession) {
				// Update session hiện có với thông tin mới từ roster
				merged.set(existingSession.id, {
					...existingSession,
					startTime: existingSession.startTime || entry.startedAt || existingSession.startTime,
					duration: existingSession.duration || (entry.timeSpentSeconds ? Math.floor(entry.timeSpentSeconds / 60) : existingSession.duration),
					lastPing: entry.lastUpdatedAt || existingSession.lastPing,
				})
			} else {
				// Chỉ tạo session mới nếu có sessionId hợp lệ từ roster
				// Nếu không có sessionId và không match được, bỏ qua entry này
				if (entry.sessionId && entry.sessionId.trim().length > 0) {
					merged.set(entry.sessionId, {
						id: entry.sessionId,
						examId: entry.examId ? String(entry.examId) : 'unknown',
						examTitle: entry.examTitle ?? `Bài thi ${entry.examId ?? '—'}`,
						userId: entry.studentId !== null && entry.studentId !== undefined ? String(entry.studentId) : 'unknown',
						userName: `Thí sinh ${entry.studentId ?? '—'}`,
						userAvatar: undefined,
						startTime: entry.startedAt ?? new Date().toISOString(),
						endTime: undefined,
						duration: entry.timeSpentSeconds ? Math.floor(entry.timeSpentSeconds / 60) : 0,
						status: 'active',
						riskLevel: 'low',
						cameraEnabled: true,
						audioEnabled: true,
						videoStreamUrl: undefined,
						faceDetected: true,
						faceCount: 1,
						gazeDirection: 'center',
						audioDetected: false,
						totalViolations: 0,
						violations: [],
						tabSwitches: 0,
						fullscreenExited: 0,
						browserChanged: false,
						connectionStatus: 'online',
						lastPing: entry.lastUpdatedAt ?? undefined,
					})
				}
			}
		}

		return Array.from(merged.values())
	}, [activeRoster, allSessions])

	const displayedCameraSessions = useMemo<ProctoringSession[]>(() => {
		if (!streamSessions.length) {
			return sessions
		}

		const existing = new Map(sessions.map(session => [session.id, session]))
		const extras = streamSessions.filter(session => !existing.has(session.id) && matchesFilters(session))

		return [...sessions, ...extras]
	}, [matchesFilters, sessions, streamSessions])

	const {
		streamStates,
		requestStream,
		stopStream,
		stats: streamConnectionStats
	} = useProctoringStreams(streamSessions)

	const [viewMode, setViewMode] = useState<ViewMode>('grid')
	const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)

	const handleSessionClick = (session: any) => {
		setSelectedSession(session)
		setIsDetailModalOpen(true)
	}

	const handleTerminate = (sessionId: string) => {
		if (confirm('Bạn có chắc chắn muốn dừng phiên thi này?')) {
			terminateSession(sessionId)
			setIsDetailModalOpen(false)
		}
	}

	const handleSendWarning = (sessionId: string) => {
		sendWarning(sessionId)
		alert('Đã gửi cảnh báo tới thí sinh!')
	}

	const handleResolveViolation = (violationId: string) => {
		if (selectedSession) {
			resolveViolation(selectedSession.id, violationId)
		}
	}

	return (
		<div style={{ padding: '24px' }}>
			{/* Header */}
			<div style={{ marginBottom: '24px' }}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
					<div>
						<h1 style={{ fontSize: '28px', fontWeight: 700, margin: '0 0 8px 0' }}>
							Giám Sát & Chống Gian Lận
						</h1>
						<p style={{ color: 'var(--muted-foreground)', margin: 0 }}>
							Theo dõi thời gian thực các phiên thi đang diễn ra
						</p>
					</div>

					<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
						<div className="realtime-indicator">
							<div className="realtime-pulse" />
							<span>Cập nhật trực tiếp</span>
						</div>
								<div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px', color: 'var(--muted-foreground)' }}>
									<div>
										<span style={{ color: '#10b981', fontWeight: 600 }}>{streamConnectionStats.totalLive}</span> luồng đang phát
									</div>
									<div>
										<span style={{ color: '#f59e0b', fontWeight: 600 }}>{streamConnectionStats.totalConnecting}</span> đang kết nối ·{' '}
										<span style={{ color: '#ef4444', fontWeight: 600 }}>{streamConnectionStats.totalError}</span> lỗi
									</div>
								</div>
						
						<label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
							<input
								type="checkbox"
								checked={autoRefresh}
								onChange={(e) => setAutoRefresh(e.target.checked)}
								style={{ width: '18px', height: '18px', cursor: 'pointer' }}
							/>
							<span style={{ fontSize: '14px' }}>Tự động làm mới</span>
						</label>
					</div>
				</div>
			</div>

			<ActiveRosterPanel
				roster={activeRoster}
				loading={rosterLoading}
				error={rosterError}
				onRefresh={refreshRoster}
				lastFetchedAt={rosterLastFetchedAt}
			/>

			{/* Stats Overview */}
			<div style={{ 
				display: 'grid', 
				gridTemplateColumns: 'repeat(4, 1fr)', 
				gap: '16px',
				marginBottom: '24px'
			}}>
				{/* Card 1 - Phiên thi đang diễn ra */}
				<div style={{ 
					background: 'var(--card)',
					borderRadius: 'var(--radius-lg)',
					padding: '20px',
					boxShadow: 'var(--shadow-sm)',
					border: '1px solid var(--border)',
					position: 'relative',
					overflow: 'hidden'
				}}>
					<div style={{ 
						position: 'absolute',
						top: '0',
						right: '0',
						width: '80px',
						height: '80px',
						background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(29, 78, 216, 0.05) 100%)',
						borderRadius: '50%',
						transform: 'translate(20px, -20px)'
					}} />
					<div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
						<div style={{ 
							width: '40px', 
							height: '40px', 
							borderRadius: 'var(--radius-md)', 
							display: 'flex', 
							alignItems: 'center', 
							justifyContent: 'center',
							background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
							color: 'white',
							flexShrink: 0
						}}>
							<Users size={20} />
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: '13px', color: 'var(--muted-foreground)', marginBottom: '6px', fontWeight: 500 }}>
								Phiên thi đang diễn ra
							</div>
							<div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--foreground)', lineHeight: 1 }}>
								{stats.totalActive}
							</div>
						</div>
					</div>
				</div>

				{/* Card 2 - Phiên có nguy cơ cao */}
				<div style={{ 
					background: 'var(--card)',
					borderRadius: 'var(--radius-lg)',
					padding: '20px',
					boxShadow: 'var(--shadow-sm)',
					border: '1px solid var(--border)',
					position: 'relative',
					overflow: 'hidden'
				}}>
					<div style={{ 
						position: 'absolute',
						top: '0',
						right: '0',
						width: '80px',
						height: '80px',
						background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, rgba(220, 38, 38, 0.05) 100%)',
						borderRadius: '50%',
						transform: 'translate(20px, -20px)'
					}} />
					<div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
						<div style={{ 
							width: '40px', 
							height: '40px', 
							borderRadius: 'var(--radius-md)', 
							display: 'flex', 
							alignItems: 'center', 
							justifyContent: 'center',
							background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
							color: 'white',
							flexShrink: 0
						}}>
							<AlertTriangle size={20} />
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: '13px', color: 'var(--muted-foreground)', marginBottom: '6px', fontWeight: 500 }}>
								Phiên có nguy cơ cao
							</div>
							<div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--foreground)', lineHeight: 1 }}>
								{stats.highRiskSessions}
							</div>
							{stats.highRiskSessions > 0 && (
								<div style={{ fontSize: '11px', color: '#ef4444', fontWeight: 600, marginTop: '4px' }}>
									Cần chú ý!
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Card 3 - Tổng vi phạm */}
				<div style={{ 
					background: 'var(--card)',
					borderRadius: 'var(--radius-lg)',
					padding: '20px',
					boxShadow: 'var(--shadow-sm)',
					border: '1px solid var(--border)',
					position: 'relative',
					overflow: 'hidden'
				}}>
					<div style={{ 
						position: 'absolute',
						top: '0',
						right: '0',
						width: '80px',
						height: '80px',
						background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, rgba(217, 119, 6, 0.05) 100%)',
						borderRadius: '50%',
						transform: 'translate(20px, -20px)'
					}} />
					<div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
						<div style={{ 
							width: '40px', 
							height: '40px', 
							borderRadius: 'var(--radius-md)', 
							display: 'flex', 
							alignItems: 'center', 
							justifyContent: 'center',
							background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
							color: 'white',
							flexShrink: 0
						}}>
							<Eye size={20} />
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: '13px', color: 'var(--muted-foreground)', marginBottom: '6px', fontWeight: 500 }}>
								Tổng vi phạm
							</div>
							<div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--foreground)', lineHeight: 1 }}>
								{stats.totalViolations}
							</div>
						</div>
					</div>
				</div>

				{/* Card 4 - Mức rủi ro trung bình */}
				<div style={{ 
					background: 'var(--card)',
					borderRadius: 'var(--radius-lg)',
					padding: '20px',
					boxShadow: 'var(--shadow-sm)',
					border: '1px solid var(--border)',
					position: 'relative',
					overflow: 'hidden'
				}}>
					<div style={{ 
						position: 'absolute',
						top: '0',
						right: '0',
						width: '80px',
						height: '80px',
						background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(5, 150, 105, 0.05) 100%)',
						borderRadius: '50%',
						transform: 'translate(20px, -20px)'
					}} />
					<div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
						<div style={{ 
							width: '40px', 
							height: '40px', 
							borderRadius: 'var(--radius-md)', 
							display: 'flex', 
							alignItems: 'center', 
							justifyContent: 'center',
							background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
							color: 'white',
							flexShrink: 0
						}}>
							<Activity size={20} />
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: '13px', color: 'var(--muted-foreground)', marginBottom: '6px', fontWeight: 500 }}>
								Mức rủi ro trung bình
							</div>
							<div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--foreground)', lineHeight: 1 }}>
								{stats.avgRiskLevel.toFixed(1)}/4
							</div>
							{stats.avgRiskLevel < 2 && (
								<div style={{ fontSize: '11px', color: '#10b981', fontWeight: 600, marginTop: '4px' }}>
									Tình hình ổn định
								</div>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Filters & Controls */}
			<div style={{ 
				display: 'flex', 
				justifyContent: 'space-between', 
				alignItems: 'center',
				marginBottom: '24px',
				gap: '16px',
				flexWrap: 'wrap'
			}}>
				<SearchBar
					value={filters.search}
					onChange={(value) => updateFilter('search', value)}
					placeholder="Tìm kiếm theo tên thí sinh, ID..."
				/>

				<div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
					{/* View Mode Toggle */}
					<div className="view-toggle">
						<button
							className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
							onClick={() => setViewMode('grid')}
						>
							<LayoutGrid size={18} />
						</button>
						<button
							className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
							onClick={() => setViewMode('list')}
						>
							<List size={18} />
						</button>
					</div>
				</div>
			</div>

			{/* Filters */}
			<div className="filters-container">
				<div className="filter-group">
					<label className="filter-label">Bài thi</label>
					<select
						className="filter-select"
						value={filters.examId}
						onChange={(e) => updateFilter('examId', e.target.value)}
					>
						<option value="all">Tất cả bài thi</option>
						{exams.map((exam: any) => (
							<option key={exam.id} value={exam.id}>{exam.title}</option>
						))}
					</select>
				</div>

				<div className="filter-group">
					<label className="filter-label">Trạng thái</label>
					<select
						className="filter-select"
						value={filters.status}
						onChange={(e) => updateFilter('status', e.target.value)}
					>
						<option value="all">Tất cả</option>
						<option value="active">Đang thi</option>
						<option value="paused">Tạm dừng</option>
						<option value="completed">Hoàn thành</option>
						<option value="terminated">Đã dừng</option>
					</select>
				</div>

				<div className="filter-group">
					<label className="filter-label">Mức độ rủi ro</label>
					<select
						className="filter-select"
						value={filters.riskLevel}
						onChange={(e) => updateFilter('riskLevel', e.target.value)}
					>
						<option value="all">Tất cả mức độ</option>
						<option value="low">An toàn</option>
						<option value="medium">Cảnh báo</option>
						<option value="high">Nguy hiểm</option>
						<option value="critical">Nghiêm trọng</option>
					</select>
				</div>

				<div className="filter-group">
					<label className="filter-label">Kết quả</label>
					<div style={{ 
						padding: '8px 12px',
						background: 'var(--muted)',
						borderRadius: 'var(--radius-md)',
						fontSize: '14px',
						fontWeight: 500
					}}>
						Tìm thấy {sessions.length} phiên
					</div>
				</div>
			</div>

			{/* Sessions Display */}
			<LiveCameraWall
				sessions={displayedCameraSessions}
				streamStates={streamStates}
				onRequestStream={requestStream}
				onSessionClick={handleSessionClick}
				title="Camera trực tiếp từ thí sinh đang hoạt động"
				subtitle={activeRoster.length ? 'Danh sách dựa trên /api/proctoring/active-sessions' : 'Danh sách dựa trên dữ liệu proctoring'}
			/>

			{/* Detail Modal */}
			<SessionDetailModal
				isOpen={isDetailModalOpen}
				onClose={() => {
					setIsDetailModalOpen(false)
					setSelectedSession(null)
				}}
				session={selectedSession}
				streamState={selectedSession ? streamStates[selectedSession.id] : undefined}
				onResolveViolation={handleResolveViolation}
				onTerminate={handleTerminate}
				onSendWarning={handleSendWarning}
				onRequestStream={(sessionId, options) => requestStream(sessionId, options)}
				onStopStream={sessionId => stopStream(sessionId, 'idle')}
			/>
		</div>
	)
}
