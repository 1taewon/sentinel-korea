import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    if (mode === 'signin') {
      const { error } = await signIn(email, password);
      if (error) setError(error);
    } else {
      const { error } = await signUp(email, password);
      if (error) setError(error);
      else setMessage('가입 확인 이메일을 발송했습니다. 메일함에서 링크를 클릭하면 로그인할 수 있어요.');
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0B1120',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '"Inter", "Segoe UI", sans-serif',
    }}>
      {/* Background decoration */}
      <div style={{
        position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none',
      }}>
        {[...Array(3)].map((_, i) => (
          <div key={i} style={{
            position: 'absolute',
            borderRadius: '50%',
            border: `1px solid rgba(56,189,248,${0.04 + i * 0.02})`,
            width: `${400 + i * 200}px`,
            height: `${400 + i * 200}px`,
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
          }} />
        ))}
      </div>

      <div style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '40px',
        width: '100%',
        maxWidth: '400px',
        boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '10px', marginBottom: '8px',
          }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: 'linear-gradient(135deg, #38BDF8, #6B8AFF)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '18px',
            }}>🛡️</div>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#F1F5F9', letterSpacing: '-0.3px' }}>
              Sentinel Korea
            </span>
          </div>
          <p style={{ color: '#64748B', fontSize: '13px', margin: 0 }}>
            실시간 호흡기 감염병 조기경보 플랫폼
          </p>
        </div>

        {/* Tab switcher */}
        <div style={{
          display: 'flex', background: 'rgba(255,255,255,0.04)',
          borderRadius: '8px', padding: '4px', marginBottom: '24px',
        }}>
          {(['signin', 'signup'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(''); setMessage(''); }}
              style={{
                flex: 1, padding: '8px', border: 'none', borderRadius: '6px',
                cursor: 'pointer', fontSize: '13px', fontWeight: 500,
                transition: 'all 0.2s',
                background: mode === m ? 'rgba(56,189,248,0.15)' : 'transparent',
                color: mode === m ? '#38BDF8' : '#64748B',
              }}
            >
              {m === 'signin' ? '로그인' : '회원가입'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#94A3B8', marginBottom: '6px' }}>
              이메일
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              style={{
                width: '100%', padding: '10px 12px', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px', color: '#F1F5F9', fontSize: '14px', outline: 'none',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#94A3B8', marginBottom: '6px' }}>
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              style={{
                width: '100%', padding: '10px 12px', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px', color: '#F1F5F9', fontSize: '14px', outline: 'none',
              }}
            />
          </div>

          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '8px', padding: '10px 12px', color: '#FCA5A5', fontSize: '13px',
            }}>
              {error}
            </div>
          )}
          {message && (
            <div style={{
              background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)',
              borderRadius: '8px', padding: '10px 12px', color: '#6EE7B7', fontSize: '13px',
            }}>
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '11px', border: 'none', borderRadius: '8px', cursor: loading ? 'wait' : 'pointer',
              background: loading ? 'rgba(56,189,248,0.4)' : 'linear-gradient(135deg, #38BDF8, #6B8AFF)',
              color: '#0B1120', fontWeight: 700, fontSize: '14px',
              transition: 'opacity 0.2s', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? '처리 중...' : mode === 'signin' ? '로그인' : '가입하기'}
          </button>
        </form>

        <p style={{ textAlign: 'center', color: '#475569', fontSize: '12px', marginTop: '24px', marginBottom: 0 }}>
          Sentinel Korea MVP · 2026
        </p>
      </div>
    </div>
  );
}
