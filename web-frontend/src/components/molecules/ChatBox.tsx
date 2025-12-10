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
	// URL Gateway
	const API_URL = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'}/api/v1/ai/consult`;

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
	const [isSoundOn, setIsSoundOn] = useState(true) // Mặc định bật tiếng đọc

	const messagesEndRef = useRef<HTMLDivElement>(null)

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}

	useEffect(() => {
		scrollToBottom()
	}, [messages, isTyping])

	// --- HÀM 1: LÀM SẠCH VĂN BẢN (Clean Markdown) ---
	// Loại bỏ các ký tự **, *, #, ` để hiển thị đẹp hơn
	const cleanMarkdown = (text: string): string => {
		if (!text) return "";
		return text
			.replace(/\*\*/g, '')       // Xóa in đậm
			.replace(/^\s*\*\s/gm, '• ') // Thay dấu * đầu dòng thành dấu chấm tròn
			.replace(/`/g, '')          // Xóa dấu code
			.replace(/#{1,6}\s/g, '');  // Xóa header
	}

	// --- HÀM 2: ĐỌC VĂN BẢN (Text-to-Speech) ---
	const speakText = (text: string) => {
		if (!isSoundOn || !window.speechSynthesis) return;

		// Dừng câu đang đọc dở (nếu có)
		window.speechSynthesis.cancel();

		// Loại bỏ ký tự đặc biệt để máy đọc trơn tru hơn
		const textToRead = text.replace(/[*`#\-]/g, '');

		const utterance = new SpeechSynthesisUtterance(textToRead);
		utterance.lang = 'vi-VN'; // Giọng Việt Nam
		utterance.rate = 1.0;     // Tốc độ bình thường
		window.speechSynthesis.speak(utterance);
	}

	// --- HÀM 3: GỬI TIN NHẮN & GỌI API ---
	const handleSendMessage = async (content: string) => {
		if (!content || !content.trim()) return

		// 1. Hiển thị tin nhắn của User
		const userMessage: Message = {
			id: Date.now().toString(),
			content: content.trim(),
			sender: 'user',
			timestamp: new Date(),
			type: 'text'
		}
		setMessages(prev => [...prev, userMessage])
		setIsTyping(true) // Hiện "AI đang trả lời..."

		try {
			// 2. Chuẩn bị lịch sử chat để gửi lên Server
			const history: ChatHistoryItem[] = messages
				.filter(m => m.type === 'text')
				.map(m => ({
					role: m.sender === 'user' ? 'user' : 'assistant',
					content: m.content
				}));

			// 3. Gọi API (Gateway 8080)
			const response = await fetch(API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					// Gateway đã whitelist API này nên không cần Authorization
				},
				body: JSON.stringify({
					message: content,
					history: history
				})
			});

			const data = await response.json();

			if (response.ok && data.success) {
				const rawContent = data.data.content;

				// Xử lý text trước khi hiển thị
				const displayContent = cleanMarkdown(rawContent);

				const botMessage: Message = {
					id: (Date.now() + 1).toString(),
					content: displayContent,
					sender: 'bot',
					timestamp: new Date(),
					type: 'text'
				}
				setMessages(prev => [...prev, botMessage])

				// Đọc to câu trả lời
				speakText(rawContent);
			} else {
				throw new Error(data.message || 'Lỗi phản hồi từ server');
			}

		} catch (error) {
			console.error("Chat Error:", error);
			const errorMessage: Message = {
				id: (Date.now() + 1).toString(),
				content: 'Xin lỗi, tôi đang gặp sự cố kết nối mạng. Vui lòng thử lại sau.',
				sender: 'bot',
				timestamp: new Date(),
				type: 'text'
			}
			setMessages(prev => [...prev, errorMessage])
			speakText('Xin lỗi, tôi đang gặp sự cố kết nối mạng.');
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

					<div className={styles.inputArea}>
						<ChatInput onSendMessage={handleSendMessage} disabled={isTyping} />
					</div>
				</>
			)}
		</div>
	)
}