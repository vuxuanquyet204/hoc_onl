import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { ProctoringSession, ProctoringFilters, SessionStats } from '../types/proctoring'
import { proctoringApi } from '../services/proctoringApi'
// Import adapter để convert giữa backend và frontend
import { 
	backendSessionToProctoringSession,
	mapBackendSessionsToProctoringSessions,
	backendEventToViolation
} from '../../utils/proctoringAdapter'

const isBrowser = typeof window !== 'undefined'
// Use API Gateway WebSocket endpoint for proctoring (Socket.IO path)
const DEFAULT_PROCTORING_WS_URL =
	(isBrowser && (window as any)?.__PROCTORING_WS_URL) ??
	((import.meta as any)?.env?.VITE_PROCTORING_WS_URL as string | undefined) ??
	(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080')

export default function useProctoring() {
	const [sessions, setSessions] = useState<ProctoringSession[]>([])
	const [loading, setLoading] = useState(true)
	const [filters, setFilters] = useState<ProctoringFilters>({
		search: '',
		status: 'all',
		riskLevel: 'all',
		examId: 'all'
	})
	const [selectedSession, setSelectedSession] = useState<ProctoringSession | null>(null)
	const [autoRefresh, setAutoRefresh] = useState(true)
	
	// WebSocket connections for realtime updates
	const socketsRef = useRef<Record<string, Socket>>({})
	const sessionsRef = useRef<ProctoringSession[]>([])

	// Filter sessions
	const filteredSessions = useMemo(() => {
		let result = [...sessions]

		// ✅ Tự động filter out completed sessions (ẩn phiên thi đã hoàn thành)
		result = result.filter(s => s.status !== 'completed')

		// Search
		if (filters.search) {
			const searchLower = filters.search.toLowerCase()
			result = result.filter(s =>
				s.userName.toLowerCase().includes(searchLower) ||
				s.examTitle.toLowerCase().includes(searchLower) ||
				s.userId.toLowerCase().includes(searchLower)
			)
		}

		// Status filter
		if (filters.status !== 'all') {
			result = result.filter(s => s.status === filters.status)
		}

		// Risk level filter
		if (filters.riskLevel !== 'all') {
			result = result.filter(s => s.riskLevel === filters.riskLevel)
		}

		// Exam filter
		if (filters.examId !== 'all') {
			result = result.filter(s => s.examId === filters.examId)
		}

		return result
	}, [sessions, filters])

	// Calculate stats
	const stats: SessionStats = useMemo(() => {
		const activeSessions = sessions.filter(s => s.status === 'active')
		const highRiskSessions = activeSessions.filter(s => 
			s.riskLevel === 'high' || s.riskLevel === 'critical'
		)
		const totalViolations = activeSessions.reduce((sum, s) => sum + s.totalViolations, 0)
		
		const riskScores = activeSessions.map(s => {
			switch (s.riskLevel) {
				case 'low': return 1
				case 'medium': return 2
				case 'high': return 3
				case 'critical': return 4
				default: return 0
			}
		})
		const avgRiskLevel = riskScores.length > 0 
			? riskScores.reduce((sum: number, score) => sum + score, 0) / riskScores.length
			: 0

		return {
			totalActive: activeSessions.length,
			totalViolations,
			highRiskSessions: highRiskSessions.length,
			avgRiskLevel
		}
	}, [sessions])

	// Get unique exams
	const exams = useMemo(() => {
		const uniqueExams = Array.from(
			new Set(sessions.map(s => JSON.stringify({ id: s.examId, title: s.examTitle })))
		).map(str => JSON.parse(str))
		return uniqueExams
	}, [sessions])

	// ✅ FIX: Make transformSession a plain function to avoid re-triggering useEffect
	const transformSession = (s: any): ProctoringSession => {
		const events = s.events || []
		// Use adapter to convert backend session to frontend format
		return backendSessionToProctoringSession(s, events)
	}

	// Fetch sessions from API
	useEffect(() => {
		const fetchSessions = async () => {
			setLoading(true)
			try {
				const data = await proctoringApi.getAllSessions()
				
				// Backend already includes events in response, but fetch separately for reliability
				const sessionsWithEvents = await Promise.all(
					data.map(async (session: any) => {
						// Use events from include if available, otherwise fetch separately
						let events = session.events || []
						
						// If no events in response, fetch separately
						if (!events || events.length === 0) {
							try {
								events = await proctoringApi.getEventsBySession(session.id)
							} catch (error) {
								console.error(`Error fetching events for session ${session.id}:`, error)
								events = []
							}
						}
						
						return { ...session, events }
					})
				)
				
				const transformedSessions = sessionsWithEvents.map(transformSession)
				setSessions(transformedSessions)
			} catch (error) {
				console.error('Error fetching sessions:', error)
			} finally {
				setLoading(false)
			}
		}

		fetchSessions()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Update filter
	const updateFilter = useCallback((key: keyof ProctoringFilters, value: any) => {
		setFilters(prev => ({ ...prev, [key]: value }))
	}, [])

	// Keep sessionsRef in sync with sessions state
	useEffect(() => {
		sessionsRef.current = sessions
	}, [sessions])

	// WebSocket setup for realtime updates
	useEffect(() => {
		if (!isBrowser || sessions.length === 0) return

		// Get unique examIds from sessions
		const examIds = Array.from(new Set(sessions.map(s => s.examId)))

		// Create socket connections for each exam
		examIds.forEach(examId => {
			if (socketsRef.current[examId]) {
				// Socket already exists for this exam
				return
			}

			const socket = io(DEFAULT_PROCTORING_WS_URL, {
				path: '/socket.io',
				query: {
					examId: String(examId),
					userId: 'admin-dashboard',
					userType: 'proctor'
				},
				transports: ['websocket'],
				reconnection: true,
				reconnectionAttempts: 5,
				reconnectionDelay: 1000,
				reconnectionDelayMax: 5000,
				timeout: 20000
			})

			socket.on('connect', () => {
				// WebSocket connected
			})

			socket.on('connected', () => {
				// Server confirmed connection
			})

			socket.on('connect_error', () => {
				// Connection error
			})

			socket.on('reconnect', () => {
				// Reconnected
			})

			socket.on('reconnect_attempt', () => {
				// Attempting to reconnect
			})

			socket.on('reconnect_error', () => {
				// Reconnection error
			})

			socket.on('reconnect_failed', () => {
				// Reconnection failed
			})

			socket.on('disconnect', () => {
				// WebSocket disconnected
			})

			// Listen for proctoring alerts (violations)
			socket.on('proctoring_alert', (event: any) => {
				
				// Find the session that matches this event
				const sessionId = event.sessionId || event.id
				if (!sessionId) return

				setSessions(prev => {
					const sessionIndex = prev.findIndex(s => s.id === sessionId)
					if (sessionIndex === -1) {
						// Session not found, might need to refresh
						return prev
					}

					const session = prev[sessionIndex]
					
					// Convert backend event to violation
					const newViolation = backendEventToViolation(event)
					
					// Check if violation already exists
					const violationExists = session.violations.some(v => v.id === newViolation.id)
					if (violationExists) {
						return prev
					}

					// Add new violation to session
					const updatedViolations = [...session.violations, newViolation]
					
					// Update session with new violation
					const updatedSession: ProctoringSession = {
						...session,
						violations: updatedViolations,
						totalViolations: updatedViolations.length,
						tabSwitches: updatedViolations.filter(v => v.type === 'tab_switch').length,
						// Update face detection status based on violations
						faceDetected: updatedViolations.filter(v => v.type === 'no_face_detected').length === 0 && session.faceDetected,
						faceCount: updatedViolations.some(v => v.type === 'multiple_faces') ? 2 : 1
					}

					// Update risk level based on new violations
					const unresolvedViolations = updatedViolations.filter(v => !v.resolved).length
					const criticalViolations = updatedViolations.filter(v => 
						v.severity === 'critical' && !v.resolved
					).length

					let riskLevel: typeof session.riskLevel = 'low'
					if (criticalViolations > 0 || unresolvedViolations >= 5) {
						riskLevel = 'critical'
					} else if (unresolvedViolations >= 3) {
						riskLevel = 'high'
					} else if (unresolvedViolations >= 1) {
						riskLevel = 'medium'
					}
					updatedSession.riskLevel = riskLevel

					// Update selected session if it's the one being updated
					setSelectedSession(prev => {
						if (prev?.id === sessionId) {
							return updatedSession
						}
						return prev
					})

					// Return updated sessions array
					const newSessions = [...prev]
					newSessions[sessionIndex] = updatedSession
					return newSessions
				})
			})

			// Listen for session status updates (camera, mic, face, connection)
			socket.on('session_status_update', (update: any) => {
				
				const sessionId = update.sessionId
				if (!sessionId) return

				setSessions(prev => {
					const sessionIndex = prev.findIndex(s => s.id === sessionId)
					if (sessionIndex === -1) return prev

					const session = prev[sessionIndex]
					const updatedSession: ProctoringSession = {
						...session,
						// Update status fields if provided
						cameraEnabled: update.cameraEnabled !== undefined ? update.cameraEnabled : session.cameraEnabled,
						audioEnabled: update.audioEnabled !== undefined ? update.audioEnabled : session.audioEnabled,
						faceDetected: update.faceDetected !== undefined ? update.faceDetected : session.faceDetected,
						faceCount: update.faceCount !== undefined ? update.faceCount : session.faceCount,
						connectionStatus: update.connectionStatus !== undefined ? update.connectionStatus : session.connectionStatus,
						lastPing: update.timestamp || new Date().toISOString()
					}

					// Update selected session if it's the one being updated
					setSelectedSession(prev => {
						if (prev?.id === sessionId) {
							return updatedSession
						}
						return prev
					})

					const newSessions = [...prev]
					newSessions[sessionIndex] = updatedSession
					return newSessions
				})
			})

			// ✅ Listen for session completed event - tự động remove session khỏi danh sách
			socket.on('proctoring_session_completed', (data: any) => {
				
				const sessionId = data.sessionId || data.id
				if (!sessionId) return

				setSessions(prev => {
					const sessionIndex = prev.findIndex(s => s.id === sessionId)
					if (sessionIndex === -1) return prev

					// Remove session khỏi danh sách (hoặc mark as completed để filter out)
					const newSessions = prev.filter(s => s.id !== sessionId)
					
					// Close modal nếu đang xem session này
					setSelectedSession(prevSelected => {
						if (prevSelected?.id === sessionId) {
							return null
						}
						return prevSelected
					})

					return newSessions
				})
			})

			socketsRef.current[examId] = socket
		})

		// Cleanup: disconnect sockets for exams that no longer have sessions
		return () => {
			Object.keys(socketsRef.current).forEach(examId => {
				if (!examIds.includes(examId)) {
					socketsRef.current[examId]?.disconnect()
					delete socketsRef.current[examId]
				}
			})
		}
	}, [sessions.map(s => s.examId).join(',')])

	// ✅ FIX: Auto refresh without transformSession in dependency to avoid re-creating interval
	// Reduced frequency since we have WebSocket updates now
	useEffect(() => {
		if (!autoRefresh) return

		const interval = setInterval(async () => {
			try {
				const data = await proctoringApi.getAllSessions()
				
				// Use events from include if available, otherwise fetch separately
				const sessionsWithEvents = await Promise.all(
					data.map(async (session: any) => {
						let events = session.events || []
						
						if (!events || events.length === 0) {
							try {
								events = await proctoringApi.getEventsBySession(session.id)
							} catch (error) {
								console.error(`Error fetching events for session ${session.id}:`, error)
								events = []
							}
						}
						
						return { ...session, events }
					})
				)
				
				const transformedSessions = sessionsWithEvents.map(transformSession)
				setSessions(transformedSessions)
			} catch (error) {
				console.error('Error refreshing sessions:', error)
			}
		}, 30000) // Update every 30 seconds (reduced from 5s since we have WebSocket)

		return () => clearInterval(interval)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoRefresh])

	// Terminate session
	const terminateSession = useCallback(async (sessionId: string) => {
		const success = await proctoringApi.terminateSession(sessionId)
		if (success) {
			setSessions(prev => prev.map(s =>
				s.id === sessionId
					? {
						...s,
						status: 'terminated' as const,
						endTime: new Date().toISOString()
					}
					: s
			))
			if (selectedSession?.id === sessionId) {
				setSelectedSession(null)
			}
		}
	}, [selectedSession])

	// Send warning
	const sendWarning = useCallback(async (sessionId: string) => {
		const success = await proctoringApi.sendWarning(sessionId)
		return success
	}, [])

	// Resolve violation
	const resolveViolation = useCallback(async (sessionId: string, violationId: string) => {
		const success = await proctoringApi.reviewEvent(violationId, true)
		if (success) {
			setSessions(prev => prev.map(s =>
				s.id === sessionId
					? {
						...s,
						violations: s.violations.map(v =>
							v.id === violationId ? { ...v, resolved: true } : v
						)
					}
					: s
			))
		}
	}, [])

	// Update risk level based on violations
	useEffect(() => {
		setSessions(prev => prev.map(session => {
			if (session.status !== 'active') return session

			const unresolvedViolations = session.violations.filter(v => !v.resolved).length
			const criticalViolations = session.violations.filter(v => 
				v.severity === 'critical' && !v.resolved
			).length

			let riskLevel: typeof session.riskLevel = 'low'
			
			if (criticalViolations > 0 || unresolvedViolations >= 5) {
				riskLevel = 'critical'
			} else if (unresolvedViolations >= 3) {
				riskLevel = 'high'
			} else if (unresolvedViolations >= 1) {
				riskLevel = 'medium'
			}

			return { ...session, riskLevel }
		}))
	}, [sessions.map(s => s.violations.length).join(',')])

	return {
		sessions: filteredSessions,
		allSessions: sessions,
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
	}
}

