import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import type { ProctoringSession } from '../types/proctoring'

const ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' }
]

export type LiveStreamStatus = 'idle' | 'waiting' | 'connecting' | 'live' | 'error'

export interface StreamState {
	status: LiveStreamStatus
	stream: MediaStream | null
	lastUpdated?: number
	error?: string
	remoteSocketId?: string
}

interface UseProctoringStreamsOptions {
	proctorId?: string
	autoRequest?: boolean
	serverUrl?: string
}

interface RequestOptions {
	force?: boolean
}

const isBrowser = typeof window !== 'undefined'

// Use API Gateway WebSocket endpoint for proctoring (Socket.IO path)
const DEFAULT_SERVER_URL =
	(typeof window !== 'undefined' && (window as any)?.__PROCTORING_WS_URL) ??
	((import.meta as any)?.env?.VITE_PROCTORING_WS_URL as string | undefined) ??
	(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080')

export function useProctoringStreams(
	allSessions: ProctoringSession[],
	options?: UseProctoringStreamsOptions
) {
	const {
		proctorId = 'admin-dashboard',
		autoRequest = true,
		serverUrl = DEFAULT_SERVER_URL
	} = options ?? {}

	const [streamStates, setStreamStates] = useState<Record<string, StreamState>>({})

	const streamStatesRef = useRef<Record<string, StreamState>>({})
	const socketsRef = useRef<Record<string, Socket>>({})
	const peersRef = useRef<
		Record<
			string,
			{
				pc: RTCPeerConnection
				remoteSocketId: string
				examId: string
			}
		>
	>({})
	const remoteSessionMap = useRef<Record<string, string>>({})
	const sessionsRef = useRef<ProctoringSession[]>([])
	const requestedSessionsRef = useRef<Set<string>>(new Set())

	useEffect(() => {
		streamStatesRef.current = streamStates
	}, [streamStates])

	useEffect(() => {
		sessionsRef.current = allSessions
	}, [allSessions])

	useEffect(() => {
		if (!allSessions || allSessions.length === 0) return

		setStreamStates(prev => {
			const next = { ...prev }
			for (const session of allSessions) {
				if (!next[session.id]) {
					next[session.id] = {
						status: 'idle',
						stream: null
					}
				}
			}
			return next
		})
	}, [allSessions])

	const teardownPeer = useCallback((sessionId: string) => {
		const peerInfo = peersRef.current[sessionId]
		if (peerInfo) {
			try {
				peerInfo.pc.ontrack = null
				peerInfo.pc.onicecandidate = null
				peerInfo.pc.onconnectionstatechange = null
				peerInfo.pc.close()
			} catch (error) {
				console.warn('Không thể đóng kết nối WebRTC:', error)
			}
			delete peersRef.current[sessionId]
			if (peerInfo.remoteSocketId) {
				delete remoteSessionMap.current[peerInfo.remoteSocketId]
			}
		}

		const existingStream = streamStatesRef.current[sessionId]?.stream
		if (existingStream) {
			existingStream.getTracks().forEach(track => {
				try {
					track.stop()
				} catch {
					// ignore
				}
			})
		}
	}, [])

	const stopStream = useCallback(
		(sessionId: string, nextStatus: LiveStreamStatus = 'idle', errorMessage?: string) => {
			teardownPeer(sessionId)
			requestedSessionsRef.current.delete(sessionId)
			setStreamStates(prev => ({
				...prev,
				[sessionId]: {
					status: nextStatus,
					stream: null,
					lastUpdated: prev[sessionId]?.lastUpdated,
					remoteSocketId: undefined,
					error: errorMessage
				}
			}))
		},
		[teardownPeer]
	)

	const ensureSocket = useCallback(
		(examId: string) => {
			if (!isBrowser) return null

			if (socketsRef.current[examId]) {
				return socketsRef.current[examId]
			}

			const socket = io(serverUrl, {
				path: '/socket.io',
				query: {
					examId,
					userId: proctorId,
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
				// Socket connected
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
				const relatedSessions = sessionsRef.current.filter(
					session => session.examId === examId
				)
				for (const session of relatedSessions) {
					stopStream(session.id, 'error', 'Không thể kết nối lại với máy chủ giám sát')
				}
			})

			socket.on('disconnect', () => {
				// Socket disconnected
				const relatedSessions = sessionsRef.current.filter(
					session => session.examId === examId
				)
				for (const session of relatedSessions) {
					stopStream(session.id, 'error', 'Mất kết nối tới máy chủ giám sát')
				}
			})

			socket.on('user_left', ({ userId }: { userId: string }) => {
				const relatedSessions = sessionsRef.current.filter(
					session =>
						session.examId === examId && String(session.userId) === String(userId)
				)
				for (const session of relatedSessions) {
					stopStream(session.id, 'error', 'Thí sinh đã ngắt kết nối')
				}
			})

			socket.on(
				'webrtc_offer_received',
				async (payload: {
					offer: RTCSessionDescriptionInit
					senderSocketId: string
					studentId: string
				}) => {
					const { offer, senderSocketId, studentId } = payload
					const targetSession = sessionsRef.current.find(
						session =>
							session.examId === examId &&
							String(session.userId) === String(studentId)
					)

					if (!targetSession) {
						return
					}

					const sessionId = targetSession.id

					try {
						teardownPeer(sessionId)

						const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
						peersRef.current[sessionId] = {
							pc,
							remoteSocketId: senderSocketId,
							examId
						}
						remoteSessionMap.current[senderSocketId] = sessionId

						pc.ontrack = event => {
							const [remoteStream] = event.streams
							if (!remoteStream || remoteStream.getTracks().length === 0) {
								return
							}

							setStreamStates(prev => ({
								...prev,
								[sessionId]: {
									status: 'live',
									stream: remoteStream,
									lastUpdated: Date.now(),
									error: undefined,
									remoteSocketId: senderSocketId
								}
							}))
						}

						pc.onicecandidate = event => {
							if (event.candidate) {
								socket.emit('webrtc_ice_candidate', {
									candidate: event.candidate,
									targetSocketId: senderSocketId
								})
							}
						}

						pc.onconnectionstatechange = () => {
							const state = pc.connectionState
							if (state === 'failed') {
								stopStream(
									sessionId,
									'error',
									'Không thể thiết lập kết nối video'
								)
							} else if (state === 'disconnected') {
								stopStream(sessionId, 'error', 'Kết nối video đã bị gián đoạn')
							} else if (state === 'closed') {
								stopStream(sessionId, 'idle')
							} else if (state === 'connected') {
								// Khi connected, đảm bảo stream state được cập nhật
								const currentState = streamStatesRef.current[sessionId]
								if (currentState && currentState.status !== 'live' && currentState.stream) {
									setStreamStates(prev => ({
										...prev,
										[sessionId]: {
											...prev[sessionId],
											status: 'live',
											lastUpdated: Date.now()
										}
									}))
								}
							}
						}

						await pc.setRemoteDescription(offer as RTCSessionDescriptionInit)
						const answer = await pc.createAnswer()
						await pc.setLocalDescription(answer)

						socket.emit('webrtc_answer', {
							answer,
							targetSocketId: senderSocketId
						})

						setStreamStates(prev => ({
							...prev,
							[sessionId]: {
								status: 'connecting',
								stream: prev[sessionId]?.stream ?? null,
								lastUpdated: prev[sessionId]?.lastUpdated,
								error: undefined,
								remoteSocketId: senderSocketId
							}
						}))
					} catch (error) {
						stopStream(
							sessionId,
							'error',
							error instanceof Error
								? error.message
								: 'Không thể thiết lập kết nối video'
						)
					}
				}
			)

			socket.on(
				'webrtc_ice_candidate_received',
				async (payload: {
					candidate: RTCIceCandidateInit | null
					senderSocketId: string
				}) => {
					const { candidate, senderSocketId } = payload
					const sessionId = remoteSessionMap.current[senderSocketId]
					if (!sessionId) return

					const peerInfo = peersRef.current[sessionId]
					if (!peerInfo) return

					try {
						if (candidate) {
							await peerInfo.pc.addIceCandidate(
								new RTCIceCandidate(candidate)
							)
						} else {
							await peerInfo.pc.addIceCandidate(null)
						}
					} catch (error) {
						// Error adding ICE candidate
					}
				}
			)

			socketsRef.current[examId] = socket
			return socket
		},
		[proctorId, serverUrl, stopStream]
	)

	const requestStream = useCallback(
		(sessionId: string, requestOptions?: RequestOptions) => {
			if (!isBrowser) return

			const session = sessionsRef.current.find(s => s.id === sessionId)
			if (!session) {
				return
			}

			const currentState = streamStatesRef.current[sessionId]
			if (
				!requestOptions?.force &&
				currentState &&
				(currentState.status === 'waiting' ||
					currentState.status === 'connecting' ||
					currentState.status === 'live')
			) {
				return
			}

			const socket = ensureSocket(session.examId)
			if (!socket) return

			requestedSessionsRef.current.add(sessionId)
			setStreamStates(prev => ({
				...prev,
				[sessionId]: {
					status: 'waiting',
					stream: prev[sessionId]?.stream ?? null,
					lastUpdated: prev[sessionId]?.lastUpdated,
					error: undefined,
					remoteSocketId: undefined
				}
			}))

			socket.emit('proctor_request_stream', {
				studentIdToView: session.userId
			})
		},
		[ensureSocket]
	)

	useEffect(() => {
		if (!autoRequest) return

		const activeSessionIds = new Set<string>()

		for (const session of sessionsRef.current) {
			if (session.status === 'active') {
				activeSessionIds.add(session.id)
				const state = streamStatesRef.current[session.id]
				if (!state || state.status === 'idle') {
					requestStream(session.id)
				}
			}
		}

		for (const [sessionId, state] of Object.entries(streamStatesRef.current)) {
			if (!activeSessionIds.has(sessionId) && state.stream) {
				stopStream(sessionId, 'idle')
			}
		}
	}, [autoRequest, requestStream, stopStream])

	useEffect(() => {
		return () => {
			for (const peerInfo of Object.values(peersRef.current)) {
				try {
					peerInfo.pc.close()
				} catch {
					// ignore
				}
			}
			for (const socket of Object.values(socketsRef.current)) {
				socket.removeAllListeners()
				if (socket.connected) {
					socket.disconnect()
				}
			}
			peersRef.current = {}
			socketsRef.current = {}
			remoteSessionMap.current = {}
		}
	}, [])

	const stats = useMemo(() => {
		const values = Object.values(streamStates)
		const totalLive = values.filter(
			state => state.status === 'live'
		).length
		const totalConnecting = values.filter(
			state => state.status === 'connecting' || state.status === 'waiting'
		).length
		const totalError = values.filter(
			state => state.status === 'error'
		).length
		return {
			totalLive,
			totalConnecting,
			totalError
		}
	}, [streamStates])

	return {
		streamStates,
		requestStream,
		stopStream,
		stats
	}
}


