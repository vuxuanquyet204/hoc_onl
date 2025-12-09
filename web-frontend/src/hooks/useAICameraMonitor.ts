import { useState, useEffect, useRef, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import { proctoringService } from '../services/proctoringService';
import { cameraManager } from '../services/cameraManager';
import { useFrameStorage } from './useFrameStorage';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const isBrowser = typeof window !== 'undefined';

// Use API Gateway WebSocket endpoint for proctoring (Socket.IO path)
const DEFAULT_PROCTORING_WS_URL =
  (isBrowser && (window as any)?.__PROCTORING_WS_URL) ??
  ((import.meta as any)?.env?.VITE_PROCTORING_WS_URL as string | undefined) ??
  (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080');

export interface CheatingDetection {
  type: 'FACE_NOT_DETECTED' | 'MULTIPLE_FACES' | 'MOBILE_PHONE_DETECTED' | 'CAMERA_TAMPERED' | 'LOOKING_AWAY' | 'tab_switch';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number; // 0-100
  timestamp: number;
  description: string;
  screenshot?: string;
  metadata?: any;
}

export interface CameraMetrics {
  fps: number;
  resolution: string;
  brightness: number;
  contrast: number;
  isStable: boolean;
}

export interface AICameraMonitorReturn {
  // Camera state
  isActive: boolean;
  isAnalyzing: boolean;
  error: string | null;
  
  // Detection results
  detections: CheatingDetection[];
  metrics: CameraMetrics | null;
  
  // Actions
  startMonitoring: () => Promise<void>;
  stopMonitoring: () => void;
  captureScreenshot: () => string | null;
  
  // Configuration
  setDetectionSensitivity: (level: 'low' | 'medium' | 'high') => void;
  enableDetectionType: (type: CheatingDetection['type'], enabled: boolean) => void;
  
  // Frame Storage
  frameStorage: {
    totalFramesCaptured: number;
    totalDetections: number;
    storageSize: number;
    getStatistics: () => any;
    exportData: () => void;
    clearAll: () => void;
  };
}

interface UseAICameraMonitorProps {
  examId?: string;
  studentId?: string;
  sessionId?: string;
  onAdminWarning?: (data: { message: string; sentBy?: string | null; timestamp: string }) => void;
  onExamTerminated?: (data: { reason?: string; terminatedBy?: string | null }) => void;
}

interface CameraState {
  isActive: boolean;
  isAnalyzing: boolean;
  error: string | null;
  detections: CheatingDetection[];
  metrics: CameraMetrics | null;
  detectionSensitivity: 'low' | 'medium' | 'high';
  enabledDetections: Set<CheatingDetection['type']>;
}

const initialState: CameraState = {
  isActive: false,
  isAnalyzing: false,
  error: null,
  detections: [],
  metrics: null,
  detectionSensitivity: 'medium',
  enabledDetections: new Set(['FACE_NOT_DETECTED', 'MULTIPLE_FACES', 'MOBILE_PHONE_DETECTED', 'CAMERA_TAMPERED', 'LOOKING_AWAY', 'tab_switch'])
};

export const useAICameraMonitor = (props?: UseAICameraMonitorProps): AICameraMonitorReturn => {
  const { examId = 'default', studentId = '1', sessionId, onAdminWarning, onExamTerminated } = props || {};
  const [state, setState] = useState<CameraState>(initialState);
  
  // Frame Storage Hook
  const frameStorage = useFrameStorage({
    maxFrames: 100,
    maxResponses: 200,
    autoCleanup: true,
    cleanupInterval: 60000 // 1 minute
  });
  
  // Refs for tracking state
  const isActiveRef = useRef(false);
  const detectionCooldownRef = useRef(0); // Cooldown between detections

  // Helper functions to update state
  const updateState = useCallback((updates: Partial<CameraState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  const analysisIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastDetectionTimeRef = useRef<number>(0);
  const cameraUsageRef = useRef(false);
  const visibilityListenerRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  const teardownPeerConnection = useCallback((proctorSocketId: string) => {
    const peer = peerConnectionsRef.current.get(proctorSocketId);
    if (!peer) {
      return;
    }

    try {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    } catch (error) {
      console.warn('[AICameraMonitor] Không thể đóng peer connection', error);
    }

    peerConnectionsRef.current.delete(proctorSocketId);
  }, []);

  const teardownAllPeers = useCallback(() => {
    peerConnectionsRef.current.forEach((_peer, proctorSocketId) => {
      teardownPeerConnection(proctorSocketId);
    });
    peerConnectionsRef.current.clear();
  }, [teardownPeerConnection]);

  const respondToProctorOfferRequest = useCallback(
    async (proctorSocketId: string) => {
      if (!isBrowser) {
        return;
      }

      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        console.warn('[AICameraMonitor] Socket chưa sẵn sàng để gửi stream');
        return;
      }

      const existingPeer = peerConnectionsRef.current.get(proctorSocketId);
      if (existingPeer) {
        teardownPeerConnection(proctorSocketId);
      }

      let stream = cameraManager.currentStream;
      if (!stream) {
        try {
          stream = await cameraManager.start();
        } catch (error) {
          console.error('[AICameraMonitor] Không thể khởi tạo camera để stream cho giám thị', error);
          return;
        }
      }

      if (!stream) {
        console.warn('[AICameraMonitor] Không có camera stream để gửi cho giám thị');
        return;
      }

      const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current.set(proctorSocketId, peerConnection);

      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream!);
      });

      peerConnection.onicecandidate = event => {
        if (event.candidate) {
          socket.emit('webrtc_ice_candidate', {
            candidate: event.candidate,
            targetSocketId: proctorSocketId,
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          teardownPeerConnection(proctorSocketId);
        }
      };

      try {
        const offer = await peerConnection.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
        await peerConnection.setLocalDescription(offer);

        socket.emit('webrtc_offer', {
          offer,
          targetSocketId: proctorSocketId,
        });
      } catch (error) {
        console.error('[AICameraMonitor] Lỗi khi tạo WebRTC offer cho giám thị', error);
        teardownPeerConnection(proctorSocketId);
      }
    },
    [teardownPeerConnection],
  );

  useEffect(() => {
    if (!isBrowser) {
      return;
    }

    if (!examId || !studentId) {
      return;
    }

    const serverUrl = DEFAULT_PROCTORING_WS_URL;
    const normalizedExamId = String(examId);
    const normalizedStudentId = String(studentId);

    const socket = io(serverUrl, {
      path: '/socket.io',
      query: {
        examId: normalizedExamId,
        userId: normalizedStudentId,
        userType: 'student',
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    socketRef.current = socket;

    const handleOfferRequest = (payload: { proctorSocketId?: string; studentIdToView?: string }) => {
      const { proctorSocketId, studentIdToView } = payload || {};
      if (!proctorSocketId) {
        return;
      }
      if (studentIdToView && String(studentIdToView) !== normalizedStudentId) {
        return;
      }
      respondToProctorOfferRequest(proctorSocketId);
    };

    const handleAnswerReceived = async (payload: { answer: RTCSessionDescriptionInit; senderSocketId: string }) => {
      const { answer, senderSocketId } = payload;
      const peer = peerConnectionsRef.current.get(senderSocketId);
      if (!peer || !answer) {
        return;
      }

      try {
        if (!peer.remoteDescription || peer.remoteDescription.type !== answer.type) {
          await peer.setRemoteDescription(answer);
        }
      } catch (error) {
        console.error('[AICameraMonitor] Không thể thiết lập remote description', error);
        teardownPeerConnection(senderSocketId);
      }
    };

    const handleIceCandidateReceived = async (payload: { candidate: RTCIceCandidateInit | null; senderSocketId: string }) => {
      const { candidate, senderSocketId } = payload;
      const peer = peerConnectionsRef.current.get(senderSocketId);
      if (!peer) {
        return;
      }

      try {
        if (candidate) {
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
        // Note: addIceCandidate(null) is deprecated, just skip if no candidate
      } catch (error) {
        console.error('[AICameraMonitor] Không thể thêm ICE candidate', error);
      }
    };

    const handleSocketDisconnect = () => {
      teardownAllPeers();
    };

    const handleAdminWarning = (data: { sessionId?: string; userId?: string; examId?: string; message?: string; sentBy?: string | null; timestamp?: string }) => {
      console.log('[AICameraMonitor] Nhận admin_warning event:', {
        data,
        currentSessionId: sessionId,
        currentStudentId: normalizedStudentId,
        currentExamId: normalizedExamId
      });
      
      // Kiểm tra xem có match không: sessionId khớp HOẶC (userId khớp VÀ examId khớp)
      let shouldProcess = false;
      let matchReason = '';
      
      // Nếu sessionId khớp
      if (sessionId && data.sessionId && data.sessionId === sessionId) {
        shouldProcess = true;
        matchReason = 'sessionId khớp';
      }
      // HOẶC nếu userId khớp (và examId khớp nếu có)
      else if (data.userId && String(data.userId) === normalizedStudentId) {
        // Nếu có examId, kiểm tra examId cũng phải khớp
        if (data.examId) {
          if (String(data.examId) === normalizedExamId) {
            shouldProcess = true;
            matchReason = 'userId và examId khớp';
          } else {
            console.log('[AICameraMonitor] Bỏ qua warning: userId khớp nhưng examId không khớp', {
              receivedExamId: String(data.examId),
              expectedExamId: normalizedExamId,
              userId: String(data.userId)
            });
            return;
          }
        } else {
          // Nếu không có examId, chỉ cần userId khớp
          shouldProcess = true;
          matchReason = 'userId khớp';
        }
      }
      
      if (!shouldProcess) {
        console.log('[AICameraMonitor] Bỏ qua warning: không có điều kiện nào khớp', {
          sessionIdMatch: sessionId && data.sessionId ? data.sessionId === sessionId : 'N/A',
          userIdMatch: data.userId ? String(data.userId) === normalizedStudentId : 'N/A',
          examIdMatch: data.examId ? String(data.examId) === normalizedExamId : 'N/A'
        });
        return;
      }
      
      console.log('[AICameraMonitor] ✅ Xử lý cảnh báo từ admin:', { data, matchReason });
      if (onAdminWarning) {
        onAdminWarning({
          message: data.message || 'Bạn đã nhận được cảnh báo từ giám thị',
          sentBy: data.sentBy ?? null,
          timestamp: data.timestamp || new Date().toISOString()
        });
      }
    };

    const handleExamTerminated = (data: { sessionId?: string; examId?: string; userId?: string; reason?: string; terminatedBy?: string | null }) => {
      console.log('[AICameraMonitor] Nhận proctoring_session_terminated event:', {
        data,
        currentSessionId: sessionId,
        currentStudentId: normalizedStudentId,
        currentExamId: normalizedExamId
      });
      
      // Kiểm tra xem có match không: sessionId khớp HOẶC (userId khớp VÀ examId khớp)
      let shouldProcess = false;
      let matchReason = '';
      
      // Nếu sessionId khớp
      if (sessionId && data.sessionId && data.sessionId === sessionId) {
        shouldProcess = true;
        matchReason = 'sessionId khớp';
      }
      // HOẶC nếu userId khớp (và examId khớp nếu có)
      else if (data.userId && String(data.userId) === normalizedStudentId) {
        // Nếu có examId, kiểm tra examId cũng phải khớp
        if (data.examId) {
          if (String(data.examId) === normalizedExamId) {
            shouldProcess = true;
            matchReason = 'userId và examId khớp';
          } else {
            console.log('[AICameraMonitor] Bỏ qua terminate: userId khớp nhưng examId không khớp', {
              receivedExamId: String(data.examId),
              expectedExamId: normalizedExamId,
              userId: String(data.userId)
            });
            return;
          }
        } else {
          // Nếu không có examId, chỉ cần userId khớp
          shouldProcess = true;
          matchReason = 'userId khớp';
        }
      }
      
      if (!shouldProcess) {
        console.log('[AICameraMonitor] Bỏ qua terminate: không có điều kiện nào khớp', {
          sessionIdMatch: sessionId && data.sessionId ? data.sessionId === sessionId : 'N/A',
          userIdMatch: data.userId ? String(data.userId) === normalizedStudentId : 'N/A',
          examIdMatch: data.examId ? String(data.examId) === normalizedExamId : 'N/A'
        });
        return;
      }
      
      console.log('[AICameraMonitor] ✅ Xử lý sự kiện dừng phiên thi:', { data, matchReason });
      if (onExamTerminated) {
        onExamTerminated({
          reason: data.reason || 'Phiên thi đã bị dừng bởi giám thị',
          terminatedBy: data.terminatedBy ?? null
        });
      }
    };

    const handleConnect = () => {
      console.log('[AICameraMonitor] ✅ WebSocket connected:', {
        socketId: socket.id,
        examId: normalizedExamId,
        studentId: normalizedStudentId
      });
    };

    const handleConnected = (data: { socketId?: string; examId?: string; userId?: string; userType?: string; timestamp?: number }) => {
      console.log('[AICameraMonitor] ✅ Server confirmed connection:', data);
      updateState({ error: null });
    };

    const handleConnectError = (error: Error) => {
      console.error('[AICameraMonitor] ❌ WebSocket connection error:', error.message);
      updateState({ error: `Lỗi kết nối: ${error.message}` });
    };

    const handleReconnect = (attemptNumber: number) => {
      console.log(`[AICameraMonitor] 🔄 WebSocket reconnected after ${attemptNumber} attempts`);
      updateState({ error: null });
    };

    const handleReconnectAttempt = (attemptNumber: number) => {
      console.log(`[AICameraMonitor] 🔄 Attempting to reconnect (${attemptNumber})...`);
    };

    const handleReconnectError = (error: Error) => {
      console.error('[AICameraMonitor] ❌ Reconnection error:', error.message);
    };

    const handleReconnectFailed = () => {
      console.error('[AICameraMonitor] ❌ Reconnection failed after all attempts');
      updateState({ error: 'Không thể kết nối lại với máy chủ. Vui lòng tải lại trang.' });
    };

    socket.on('connect', handleConnect);
    socket.on('connected', handleConnected);
    socket.on('connect_error', handleConnectError);
    socket.on('reconnect', handleReconnect);
    socket.on('reconnect_attempt', handleReconnectAttempt);
    socket.on('reconnect_error', handleReconnectError);
    socket.on('reconnect_failed', handleReconnectFailed);
    socket.on('webrtc_offer_request', handleOfferRequest);
    socket.on('webrtc_answer_received', handleAnswerReceived);
    socket.on('webrtc_ice_candidate_received', handleIceCandidateReceived);
    socket.on('admin_warning', handleAdminWarning);
    socket.on('proctoring_session_terminated', handleExamTerminated);
    socket.on('disconnect', handleSocketDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('connected', handleConnected);
      socket.off('connect_error', handleConnectError);
      socket.off('reconnect', handleReconnect);
      socket.off('reconnect_attempt', handleReconnectAttempt);
      socket.off('reconnect_error', handleReconnectError);
      socket.off('reconnect_failed', handleReconnectFailed);
      socket.off('webrtc_offer_request', handleOfferRequest);
      socket.off('webrtc_answer_received', handleAnswerReceived);
      socket.off('webrtc_ice_candidate_received', handleIceCandidateReceived);
      socket.off('admin_warning', handleAdminWarning);
      socket.off('proctoring_session_terminated', handleExamTerminated);
      socket.off('disconnect', handleSocketDisconnect);
      socket.disconnect();
      teardownAllPeers();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [examId, studentId, sessionId, onAdminWarning, onExamTerminated, respondToProctorOfferRequest, teardownAllPeers, teardownPeerConnection]);

  // Tab switch detection (vẫn giữ vì dùng Browser API, không cần backend)
  const detectTabSwitch = useCallback((): CheatingDetection | null => {
    if (document.hidden) {
      return {
        type: 'tab_switch',
        severity: 'medium',
        confidence: 100,
        timestamp: Date.now(),
        description: 'Phát hiện chuyển tab hoặc cửa sổ khác'
      };
    }
    return null;
  }, []);

  const captureScreenshot = useCallback((): string | null => {
    const dataUrl = cameraManager.captureFrame();

    if (!dataUrl) {
      console.error('captureScreenshot: Unable to capture frame from shared camera');
      return null;
    }

      const minSize = 5000; // Accept if > 5KB (relaxed from calculated minimum)
    if (dataUrl.length < minSize) {
        console.error('captureScreenshot: Captured image too small:', dataUrl.length, 'bytes, expected >', minSize);
        return null;
      }
      
      return dataUrl;
  }, []);

  const updateCameraMetrics = useCallback(() => {
    const dimensions = cameraManager.getVideoDimensions();
    const fps = cameraManager.getFrameRate();

    const newMetrics: CameraMetrics = {
      fps: fps ?? 25 + Math.random() * 5,
      resolution: dimensions ? `${dimensions.width}x${dimensions.height}` : 'Không xác định',
      brightness: 50 + Math.random() * 30,
      contrast: 60 + Math.random() * 20,
      isStable: !!cameraManager.currentStream?.active,
    };

    updateState({ metrics: newMetrics });
  }, [updateState]);

  const analyzeFrame = useCallback(async () => {
    if (!isActiveRef.current) {
      return;
    }

    let newDetections: CheatingDetection[] = [];
    const startTime = Date.now();

    try {
      // === GỌI AI BACKEND THẬT ===
      const screenshot = captureScreenshot();
      if (screenshot) {
        // Lưu frame vào storage
        const frameId = frameStorage.addFrame(screenshot, examId, studentId);
        
        const response = await proctoringService.analyzeFrame({
          image: screenshot,
          examId,
          studentId,
          sessionId,
        });

        const processingTime = Date.now() - startTime;

        // Lưu response vào storage
        frameStorage.addResponse(frameId, response.detections.map(d => ({
          event_type: d.type,
          severity: d.severity,
          metadata: d.metadata
        })), processingTime);

        // Map detections từ backend
        newDetections = response.detections.map(d => ({
          ...d,
          screenshot: screenshot, // Attach screenshot to all detections
        }));
      }

      // Kiểm tra tab switch (Browser API - không cần backend)
      if (state.enabledDetections.has('tab_switch')) {
        const tabSwitchDetection = detectTabSwitch();
        if (tabSwitchDetection) {
          newDetections.push(tabSwitchDetection);
        }
      }

      // Update detections state - CHỈ HIỂN THỊ KHI THỰC SỰ CÓ VI PHẠM
      if (newDetections.length > 0) {
        const now = Date.now();
        // Giảm cooldown xuống 3 giây và chỉ áp dụng cho cùng loại vi phạm
        const lastDetection = state.detections[state.detections.length - 1];
        const shouldSkip = lastDetection && 
          (now - lastDetectionTimeRef.current < 3000) && // 3 giây cooldown
          lastDetection.type === newDetections[0].type; // Cùng loại vi phạm
        
        if (!shouldSkip) {
          setState(prev => ({ 
            ...prev,
            detections: [...prev.detections, ...newDetections].slice(-50) // Keep last 50 detections
          }));
          lastDetectionTimeRef.current = now;
        }
      }

      // Update camera metrics
      updateCameraMetrics();

    } catch (err) {
      console.error('Error analyzing frame:', err);
    }
  }, [examId, studentId, state.enabledDetections, detectTabSwitch, captureScreenshot, updateCameraMetrics]);

  const startMonitoring = useCallback(async () => {
    if (isActiveRef.current) {
      return;
    }

    try {
      updateState({ error: null, isAnalyzing: true });

      if (!cameraUsageRef.current) {
        cameraManager.incrementUsage();
        cameraUsageRef.current = true;
      }

      await cameraManager.start();

      updateState({ isActive: true, isAnalyzing: false });
      isActiveRef.current = true;

      if (!analysisIntervalRef.current) {
        analysisIntervalRef.current = setInterval(analyzeFrame, 3000);
      }

        analyzeFrame();

      const handleVisibilityChange = () => {
        if (state.enabledDetections.has('tab_switch')) {
          analyzeFrame();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerRef.current = handleVisibilityChange;
    } catch (err) {
      console.error('Error starting camera monitoring:', err);
      let errorMessage = 'Không thể khởi động camera AI';
      
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          errorMessage = 'Bạn đã từ chối quyền truy cập camera. Vui lòng cho phép camera để tiếp tục.';
        } else if (err.name === 'NotFoundError') {
          errorMessage = 'Không tìm thấy camera. Vui lòng kiểm tra camera của bạn.';
        } else if (err.name === 'NotReadableError') {
          errorMessage = 'Camera đang được sử dụng bởi ứng dụng khác.';
        } else {
          errorMessage = err.message || errorMessage;
        }
      }

      if (cameraUsageRef.current) {
        cameraManager.decrementUsage();
        cameraUsageRef.current = false;
      }
      
      updateState({ error: errorMessage, isAnalyzing: false });
    }
  }, [analyzeFrame, state.enabledDetections, updateState]);

  const stopMonitoring = useCallback(() => {
    // Set isActiveRef to false FIRST to prevent any new frames from being sent
    isActiveRef.current = false;

    // Clear the analysis interval to stop sending frames
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }

    // Remove visibility change listener
    if (visibilityListenerRef.current) {
      document.removeEventListener('visibilitychange', visibilityListenerRef.current);
      visibilityListenerRef.current = null;
    }

    // Stop camera usage
    if (cameraUsageRef.current) {
      cameraManager.decrementUsage();
      cameraUsageRef.current = false;
    }

    // Teardown all peer connections (WebRTC streams)
    teardownAllPeers();

    // Update state
    updateState({ 
      isActive: false, 
      isAnalyzing: false, 
      detections: [], 
      metrics: null,
    });

    console.log('[useAICameraMonitor] Camera monitoring stopped. Camera and frame sending disabled.');
  }, [teardownAllPeers, updateState]);

  const handleSetDetectionSensitivity = useCallback((level: 'low' | 'medium' | 'high') => {
    updateState({ detectionSensitivity: level });
    // Adjust detection thresholds based on sensitivity
    // This would be implemented with real AI models
  }, [updateState]);

  const handleEnableDetectionType = useCallback((type: CheatingDetection['type'], enabled: boolean) => {
    setState(prev => {
      const newEnabledDetections = new Set(prev.enabledDetections);
      if (enabled) {
        newEnabledDetections.add(type);
      } else {
        newEnabledDetections.delete(type);
      }
      return { ...prev, enabledDetections: newEnabledDetections };
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMonitoring();
    };
  }, [stopMonitoring]);

  return {
    isActive: state.isActive,
    isAnalyzing: state.isAnalyzing,
    error: state.error,
    detections: state.detections,
    metrics: state.metrics,
    startMonitoring,
    stopMonitoring,
    captureScreenshot,
    setDetectionSensitivity: handleSetDetectionSensitivity,
    enableDetectionType: handleEnableDetectionType,
    frameStorage: {
      totalFramesCaptured: frameStorage.totalFramesCaptured,
      totalDetections: frameStorage.totalDetections,
      storageSize: frameStorage.storageSize,
      getStatistics: frameStorage.getStatistics,
      exportData: frameStorage.exportData,
      clearAll: frameStorage.clearAll
    }
  };
};
