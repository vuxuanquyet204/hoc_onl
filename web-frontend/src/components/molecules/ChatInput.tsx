import React, { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Paperclip, Smile, Mic, MicOff } from 'lucide-react'
import styles from '../../assets/css/ChatBox.module.css'

// Định nghĩa kiểu cho Web Speech API
interface IWindow extends Window {
	webkitSpeechRecognition: any;
	SpeechRecognition: any;
}

interface ChatInputProps {
	onSendMessage: (message: string) => void
	disabled?: boolean
}

export default function ChatInput({ onSendMessage, disabled = false }: ChatInputProps): JSX.Element {
	const [message, setMessage] = useState('')
	const [isListening, setIsListening] = useState(false)
	const [speechSupported, setSpeechSupported] = useState(false)

	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const recognitionRef = useRef<any>(null)

	// Khởi tạo Speech Recognition
	useEffect(() => {
		const { webkitSpeechRecognition, SpeechRecognition } = window as unknown as IWindow;
		const SpeechRecognitionApi = SpeechRecognition || webkitSpeechRecognition;

		if (SpeechRecognitionApi) {
			setSpeechSupported(true)
			const recognition = new SpeechRecognitionApi()
			recognition.continuous = true // Cho phép nói liên tục
			recognition.interimResults = true // Lấy kết quả tạm thời (hiển thị ngay khi nói)
			recognition.lang = 'vi-VN'

			recognition.onstart = () => setIsListening(true)
			recognition.onend = () => setIsListening(false)

			recognition.onerror = (event: any) => {
				console.error('Speech recognition error:', event.error)
				setIsListening(false)
			}

			recognition.onresult = (event: any) => {
				let finalTranscript = '';

				// Duyệt qua các kết quả trả về
				for (let i = event.resultIndex; i < event.results.length; ++i) {
					if (event.results[i].isFinal) {
						finalTranscript += event.results[i][0].transcript;
					}
				}

				if (finalTranscript) {
					// Nối thêm văn bản vào ô input hiện tại
					setMessage(prev => {
						const newText = prev ? `${prev} ${finalTranscript}` : finalTranscript;
						return newText;
					});

					// Auto-resize textarea ngay lập tức
					adjustTextareaHeight();
				}
			}

			recognitionRef.current = recognition
		}
	}, [])

	// Hàm chỉnh độ cao textarea
	const adjustTextareaHeight = () => {
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto'
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
		}
	}

	// Xử lý bật/tắt Mic
	const handleVoiceInput = () => {
		if (!speechSupported || disabled) return

		if (isListening) {
			recognitionRef.current?.stop()
		} else {
			recognitionRef.current?.start()
		}
	}

	const handleSubmit = (e?: React.FormEvent) => {
		if (e) e.preventDefault()

		if (message.trim() && !disabled) {
			// Nếu đang nghe thì dừng lại khi gửi
			if (isListening) {
				recognitionRef.current?.stop();
				setIsListening(false);
			}

			onSendMessage(message)
			setMessage('')

			// Reset height
			if (textareaRef.current) {
				textareaRef.current.style.height = 'auto'
			}
		}
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmit()
		}
	}

	const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setMessage(e.target.value)
		adjustTextareaHeight()
	}

	return (
		<form className={styles.inputForm} onSubmit={handleSubmit}>
			<div className={styles.inputContainer}>
				<button
					type="button"
					className={styles.attachButton}
					title="Đính kèm file"
					disabled={disabled}
				>
					<Paperclip size={18} />
				</button>

				{speechSupported && (
					<button
						type="button"
						className={`${styles.micButton} ${isListening ? styles.listening : ''}`}
						style={{
							color: isListening ? '#ef4444' : '#6b7280',
							animation: isListening ? 'pulse 1.5s infinite' : 'none'
						}}
						title={isListening ? "Dừng ghi âm" : "Ghi âm giọng nói"}
						disabled={disabled}
						onClick={handleVoiceInput}
					>
						{isListening ? <MicOff size={18} /> : <Mic size={18} />}
					</button>
				)}

				<textarea
					ref={textareaRef}
					value={message}
					onChange={handleInputChange}
					onKeyDown={handleKeyDown}
					placeholder={isListening ? "Đang nghe bạn nói..." : "Nhập tin nhắn..."}
					className={styles.messageInput}
					disabled={disabled}
					rows={1}
				/>

				<button
					type="button"
					className={styles.emojiButton}
					title="Thêm emoji"
					disabled={disabled}
				>
					<Smile size={18} />
				</button>

				<button
					type="submit"
					className={styles.sendButton}
					disabled={disabled || !message.trim()}
					title="Gửi tin nhắn"
				>
					<Send size={18} />
				</button>
			</div>
			<style>{`
                @keyframes pulse {
                    0% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.1); opacity: 0.7; }
                    100% { transform: scale(1); opacity: 1; }
                }
            `}</style>
		</form>
	)
}