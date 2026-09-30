import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Hello from React!</h1>
      <p>
        Change this text in <code>src/App.jsx</code> and save. The page updates by itself.
      </p>
      <button type="button" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </button>
    </main>
  );
}
