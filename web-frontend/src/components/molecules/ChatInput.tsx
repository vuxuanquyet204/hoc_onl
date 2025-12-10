import React, { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Paperclip, Smile, Mic, MicOff } from 'lucide-react'
import styles from '../../assets/css/ChatBox.module.css'

// Interface cho Web Speech API
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

	// Khởi tạo Speech Recognition khi component mount
	useEffect(() => {
		const { webkitSpeechRecognition, SpeechRecognition } = window as unknown as IWindow;
		const SpeechRecognitionApi = SpeechRecognition || webkitSpeechRecognition;

		if (SpeechRecognitionApi) {
			setSpeechSupported(true);
			const recognition = new SpeechRecognitionApi();
			recognition.continuous = true; // Cho phép nói liên tục
			recognition.interimResults = true; // Hiển thị kết quả ngay khi đang nói
			recognition.lang = 'vi-VN';

			recognition.onstart = () => setIsListening(true);

			recognition.onend = () => {
				// Khi Mic tự tắt (do im lặng lâu hoặc lỗi), cập nhật state
				setIsListening(false);
			};

			recognition.onerror = (event: any) => {
				console.error('Lỗi nhận diện giọng nói:', event.error);
				setIsListening(false);
				if (event.error === 'not-allowed') {
					alert("Vui lòng cấp quyền Micro cho trình duyệt để sử dụng tính năng này.");
				}
			};

			recognition.onresult = (event: any) => {
				let finalTranscript = '';

				// Lấy kết quả đã chốt (isFinal)
				for (let i = event.resultIndex; i < event.results.length; ++i) {
					if (event.results[i].isFinal) {
						finalTranscript += event.results[i][0].transcript;
					}
				}

				// Nếu có văn bản mới, nối vào ô input
				if (finalTranscript) {
					setMessage(prev => {
						const newText = prev ? `${prev} ${finalTranscript}` : finalTranscript;
						return newText;
					});

					// Tự động chỉnh chiều cao textarea
					setTimeout(adjustTextareaHeight, 0);
				}
			};

			recognitionRef.current = recognition;
		}
	}, []);

	// Hàm chỉnh độ cao textarea
	const adjustTextareaHeight = () => {
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto';
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
		}
	}

	// Logic Bật/Tắt Mic
	const toggleListening = () => {
		if (!speechSupported || disabled) return;

		if (isListening) {
			// ĐANG NGHE -> BẤM DỪNG -> GỬI LUÔN
			recognitionRef.current?.stop();
			setIsListening(false);

			// Đợi một chút để state message cập nhật lần cuối rồi gửi
			setTimeout(() => {
				handleSubmit();
			}, 500);
		} else {
			// BẮT ĐẦU NGHE
			recognitionRef.current?.start();
		}
	}

	const handleSubmit = (e?: React.FormEvent) => {
		if (e) e.preventDefault();

		// Nếu message rỗng hoặc đang bị disable thì không gửi
		// Lưu ý: cho phép gửi khi message có nội dung kể cả khi đang listening (để force send)
		if (message.trim() && !disabled) {
			// Nếu đang nghe mà bấm Enter/Gửi -> Dừng mic luôn
			if (isListening) {
				recognitionRef.current?.stop();
				setIsListening(false);
			}

			onSendMessage(message);
			setMessage('');

			// Reset chiều cao textarea
			if (textareaRef.current) {
				textareaRef.current.style.height = 'auto';
			}
		}
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	}

	const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setMessage(e.target.value);
		adjustTextareaHeight();
	}

	return (
		<form className={styles.inputForm} onSubmit={handleSubmit}>
			<div className={styles.inputContainer}>
				<button type="button" className={styles.attachButton} title="Đính kèm file" disabled={disabled}>
					<Paperclip size={18} />
				</button>

				{speechSupported && (
					<button
						type="button"
						className={`${styles.micButton} ${isListening ? styles.listening : ''}`}
						// Style động: Nhấp nháy đỏ khi đang nghe
						style={isListening ? { color: '#ef4444', animation: 'pulse 1.5s infinite' } : {}}
						title={isListening ? "Bấm để DỪNG và GỬI" : "Bấm để nói"}
						disabled={disabled}
						onClick={toggleListening}
					>
						{isListening ? <MicOff size={18} /> : <Mic size={18} />}
					</button>
				)}

				<textarea
					ref={textareaRef}
					value={message}
					onChange={handleInputChange}
					onKeyDown={handleKeyDown}
					placeholder={isListening ? "Đang lắng nghe bạn..." : "Nhập tin nhắn..."}
					className={styles.messageInput}
					disabled={disabled}
					rows={1}
				/>

				<button type="button" className={styles.emojiButton} title="Thêm emoji" disabled={disabled}>
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

			{/* Animation cho nút Mic */}
			<style>{`
                @keyframes pulse {
                    0% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.2); opacity: 0.7; }
                    100% { transform: scale(1); opacity: 1; }
                }
            `}</style>
		</form>
	)
}