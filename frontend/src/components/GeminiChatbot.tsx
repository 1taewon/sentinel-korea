import React, { useState, useRef, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface GeminiChatbotProps {
  snapshotDate?: string;
  inSidebar?: boolean;
}

const QUICK_ACTIONS = [
  { label: 'Dashboard Analysis', action: 'interpret', prompt: '현재 대시보드 상황을 설명해줘' },
  { label: 'News Summary', action: 'summarize', prompt: '최근 호흡기 관련 뉴스를 요약해줘' },
  { label: 'Weekly Report', action: 'report', prompt: '이번 주 호흡기 감시 보고서 초안을 작성해줘' },
  { label: 'Risk Regions', action: 'chat', prompt: '현재 가장 위험한 지역과 그 이유를 알려줘' },
  { label: 'Trend Analysis', action: 'chat', prompt: '검색 트렌드 데이터를 어떻게 해석해야 할까?' },
];

export default function GeminiChatbot({ snapshotDate, inSidebar = false }: GeminiChatbotProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '안녕하세요! Sentinel Korea AI 어시스턴트입니다.\n\n대시보드 해석, 뉴스 요약, 보고서 작성 등 무엇이든 물어보세요.',
      timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const addMessage = (role: 'user' | 'assistant', content: string) => {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    setMessages(prev => [...prev, { role, content, timestamp: ts }]);
  };

  const sendChat = async (userMsg: string) => {
    if (!userMsg.trim() || isLoading) return;
    addMessage('user', userMsg);
    setInput('');
    setIsLoading(true);

    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(`${API_BASE}/chatbot/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, history, snapshot_date: snapshotDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '오류 발생');
      addMessage('assistant', data.reply);
    } catch (err: any) {
      addMessage('assistant', `[Error] ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickAction = async (action: typeof QUICK_ACTIONS[0]) => {
    if (action.action === 'interpret') {
      addMessage('user', action.prompt);
      setIsLoading(true);
      try {
        const res = await fetch(`${API_BASE}/chatbot/interpret-dashboard${snapshotDate ? `?snapshot_date=${snapshotDate}` : ''}`, {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '오류');
        addMessage('assistant', data.reply);
      } catch (err: any) {
        addMessage('assistant', `[Error] ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    } else if (action.action === 'summarize') {
      addMessage('user', action.prompt);
      setIsLoading(true);
      try {
        const res = await fetch(`${API_BASE}/chatbot/summarize-news`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '오류');
        addMessage('assistant', data.reply);
      } catch (err: any) {
        addMessage('assistant', `[Error] ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    } else if (action.action === 'report') {
      addMessage('user', action.prompt);
      setIsGeneratingReport(true);
      addMessage('assistant', 'AI가 보고서를 작성하고 있습니다. 잠시만 기다려주세요...');
      try {
        const res = await fetch(`${API_BASE}/reports/generate`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '오류');
        // 마지막 메시지 교체
        const preview = data.report_content.slice(0, 600) + (data.report_content.length > 600 ? '\n\n...(보고서 완성)' : '');
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: `**보고서 생성 완료** (${data.epiweek})\n\n${preview}`,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
          };
          return updated;
        });
      } catch (err: any) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: `보고서 작성 실패: ${err.message}`,
          };
          return updated;
        });
      } finally {
        setIsGeneratingReport(false);
      }
    } else {
      sendChat(action.prompt);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(input);
    }
  };

  const formatMessage = (content: string) => {
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  };

  return (
    <>
      <button
        id="chatbot-toggle-btn"
        className={inSidebar ? "chatbot-sidebar-btn" : "chatbot-fab"}
        onClick={() => setIsOpen(!isOpen)}
        title="Sentinel 분석"
        aria-label="Sentinel Korea AI 어시스턴트 열기"
      >
        {inSidebar ? (
          <span>Sentinel chat</span>
        ) : (
          <>
            {isOpen ? '×' : 'AI'}
            {!isOpen && <span className="chatbot-fab-label">Chat</span>}
          </>
        )}
      </button>

      {/* 챗봇 패널 */}
      {isOpen && (
        <div className="chatbot-panel" id="chatbot-panel">
          {/* 헤더 */}
          <div className="chatbot-header">
            <div className="chatbot-header-info">
              <div className="chatbot-avatar">AI</div>
              <div>
                <div className="chatbot-title">Sentinel chat</div>
                <div className="chatbot-subtitle">AI-powered insights</div>
              </div>
            </div>
            <button className="chatbot-close-btn" onClick={() => setIsOpen(false)}>×</button>
          </div>

          {/* 빠른 액션 버튼 */}
          <div className="chatbot-quick-actions">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.label}
                className="chatbot-quick-btn"
                onClick={() => handleQuickAction(qa)}
                disabled={isLoading || isGeneratingReport}
              >
                {qa.label}
              </button>
            ))}
          </div>

          {/* 메시지 목록 */}
          <div className="chatbot-messages" id="chatbot-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chatbot-message chatbot-message--${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="chatbot-avatar-small">AI</div>
                )}
                <div className="chatbot-bubble">
                  <div
                    className="chatbot-bubble-text"
                    dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }}
                  />
                  {msg.timestamp && (
                    <div className="chatbot-timestamp">{msg.timestamp}</div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="chatbot-message chatbot-message--assistant">
                <div className="chatbot-avatar-small">AI</div>
                <div className="chatbot-bubble">
                  <div className="chatbot-typing">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 입력 영역 */}
          <div className="chatbot-input-area">
            <textarea
              ref={inputRef}
              id="chatbot-input"
              className="chatbot-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="무엇이든 질문하세요... (Enter로 전송, Shift+Enter 줄바꿈)"
              rows={2}
              disabled={isLoading}
            />
            <button
              id="chatbot-send-btn"
              className="chatbot-send-btn"
              onClick={() => sendChat(input)}
              disabled={!input.trim() || isLoading}
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </>
  );
}
