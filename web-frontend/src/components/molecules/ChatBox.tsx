import React, { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Minimize2, Maximize2, Volume2, VolumeX } from 'lucide-react'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'
import styles from '../../assets/css/ChatBox.module.css'

interface Message {
	id: string
	content: string
	sender: 'user' | 'bot'
	timestamp: Date
	type?: 'text' | 'typing'
}

interface ChatBoxProps {
	isOpen: boolean
	onToggle: () => void
	onClose: () => void
}

interface ChatHistoryItem {
	role: 'user' | 'assistant';
	content: string;
}

export default function ChatBox({ isOpen, onToggle, onClose }: ChatBoxProps): JSX.Element {
	// URL API Gateway
	const API_URL = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'}/api/v1/ai/chat`;

	const [messages, setMessages] = useState<Message[]>([
		{
			id: '1',
			content: 'Xin chào! Tôi là trợ lý AI. Tôi có thể giúp gì cho việc học của bạn hôm nay?',
			sender: 'bot',
			timestamp: new Date(),
			type: 'text'
		}
	])
	const [isMinimized, setIsMinimized] = useState(false)
	const [isTyping, setIsTyping] = useState(false)
	const [isSoundOn, setIsSoundOn] = useState(true) // Giữ lại nút bật tắt loa để nghe AI nói

	const messagesEndRef = useRef<HTMLDivElement>(null)

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}

	useEffect(() => {
		scrollToBottom()
	}, [messages, isTyping])

	// --- HÀM XỬ LÝ TEXT (Xóa markdown) ---
	const cleanMarkdown = (text: string): string => {
		if (!text) return "";
		return text
			.replace(/\*\*/g, '')
			.replace(/\*/g, '•')
			.replace(/`/g, '')
			.replace(/#{1,6}\s/g, '');
	}

	// --- HÀM ĐỌC VĂN BẢN (Text-to-Speech) ---
	const speakText = (text: string) => {
		if (!isSoundOn || !window.speechSynthesis) return;
		window.speechSynthesis.cancel();

		const textToRead = text.replace(/[*`#\-]/g, '');
		const utterance = new SpeechSynthesisUtterance(textToRead);
		utterance.lang = 'vi-VN';
		window.speechSynthesis.speak(utterance);
	}

	// --- HÀM GỬI TIN NHẮN ---
	const handleSendMessage = async (content: string) => {
		if (!content || !content.trim()) return

		// 1. Hiển thị tin nhắn User
		const userMessage: Message = {
			id: Date.now().toString(),
			content: content.trim(),
			sender: 'user',
			timestamp: new Date(),
			type: 'text'
		}
		setMessages(prev => [...prev, userMessage])
		setIsTyping(true)

		try {
			// 2. Chuẩn bị messages array (bao gồm history + message mới)
			const chatMessages: ChatHistoryItem[] = [
				...messages
					.filter(m => m.type === 'text')
					.map(m => ({
						role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
						content: m.content
					})),
				{
					role: 'user' as const,
					content: content
				}
			];

			// 3. Gọi API Backend (8080)
			const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
			
			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};
			
			if (token) {
				headers['Authorization'] = `Bearer ${token}`;
			}
			
			const response = await fetch(API_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					messages: chatMessages
				})
			});

			const data = await response.json();

			if (response.ok && data.success) {
				const rawContent = data.data.content;
				const displayContent = cleanMarkdown(rawContent);

				const botMessage: Message = {
					id: (Date.now() + 1).toString(),
					content: displayContent,
					sender: 'bot',
					timestamp: new Date(),
					type: 'text'
				}
				setMessages(prev => [...prev, botMessage])
				speakText(rawContent); // AI Đọc câu trả lời
			} else {
				throw new Error(data.message || 'Lỗi kết nối');
			}

		} catch (error) {
			console.error("Chat Error:", error);
			const errorMessage: Message = {
				id: (Date.now() + 1).toString(),
				content: 'Xin lỗi, tôi đang gặp sự cố kết nối.',
				sender: 'bot',
				timestamp: new Date(),
				type: 'text'
			}
			setMessages(prev => [...prev, errorMessage])
		} finally {
			setIsTyping(false)
		}
	}

	const toggleSound = () => {
		if (isSoundOn) window.speechSynthesis.cancel();
		setIsSoundOn(!isSoundOn);
	}

	if (!isOpen) {
		return (
			<div className={styles.chatToggle} onClick={onToggle}>
				<MessageCircle size={24} />
				<div className={styles.chatBadge}><span>1</span></div>
			</div>
		)
	}

	return (
		<div className={`${styles.chatBox} ${isMinimized ? styles.minimized : ''}`}>
			{/* Header */}
			<div className={styles.chatHeader}>
				<div className={styles.chatTitle}>
					<MessageCircle size={20} />
					<span>Trợ lý AI</span>
					<div className={styles.onlineStatus}></div>
				</div>
				<div className={styles.chatActions}>
					<button
						className={styles.actionButton}
						onClick={toggleSound}
						title={isSoundOn ? "Tắt tiếng" : "Bật tiếng"}
						style={{ marginRight: '5px' }}
					>
						{isSoundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
					</button>
					<button className={styles.actionButton} onClick={() => setIsMinimized(!isMinimized)}>
						{isMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
					</button>
					<button className={styles.actionButton} onClick={onClose}>
						<X size={16} />
					</button>
				</div>
			</div>

			{/* Content */}
			{!isMinimized && (
				<>
					<div className={styles.messagesArea}>
						<div className={styles.messagesContainer}>
							{messages.map((message) => (
								<ChatMessage key={message.id} message={message} />
							))}
							{isTyping && (
								<div className={styles.typingIndicator}>
									<div className={styles.typingDots}>
										<span></span><span></span><span></span>
									</div>
									<span className={styles.typingText}>AI đang trả lời...</span>
								</div>
							)}
							<div ref={messagesEndRef} />
						</div>
					</div>

					{/* Input Area: Chỉ việc nhúng ChatInput vào */}
					<div className={styles.inputArea}>
						<ChatInput onSendMessage={handleSendMessage} disabled={isTyping} />
					</div>
				</>
			)}
		</div>
	)
}