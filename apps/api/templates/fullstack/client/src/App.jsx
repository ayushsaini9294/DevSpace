import { useEffect, useState } from 'react';

export default function App() {
  const [message, setMessage] = useState('loading…');

  useEffect(() => {
    // "api/hello" has no "/" at the start, so it also works inside Preview.
    fetch('api/hello')
      .then((res) => res.json())
      .then((data) => setMessage(data.message))
      .catch(() => setMessage('Could not reach the server. Is it running?'));
  }, []);

  return (
    <main>
      <h1>Hello from React!</h1>
      <p>
        The page is in <code>client/src/App.jsx</code>. The server is in{' '}
        <code>server/src/index.js</code>.
      </p>
      <p>
        The server says: <strong>{message}</strong>
      </p>
    </main>
  );
}
