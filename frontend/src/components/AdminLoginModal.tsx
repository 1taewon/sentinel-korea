import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

type AdminLoginModalProps = {
  onClose: () => void;
};

export default function AdminLoginModal({ onClose }: AdminLoginModalProps) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    const result = await signIn(email, password);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <div className="admin-login-modal" role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
      <form className="admin-login-card" onSubmit={handleSubmit}>
        <div className="admin-login-header">
          <div>
            <span>OPERATOR ACCESS</span>
            <h2 id="admin-login-title">Sentinel admin login</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close admin login">×</button>
        </div>
        <p className="admin-login-copy">
          Public users remain in read-only mode. Operator credentials unlock weekly pipeline execution, source upload, report generation, and archive controls.
        </p>
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
        </label>
        {error && <div className="admin-login-error">{error}</div>}
        <button className="admin-login-submit" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in as operator'}
        </button>
      </form>
    </div>
  );
}
