import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import "./App.css";
import { createResource, useSES } from "./lib/ses";

const resource = createResource((id: number) =>
  fetch(`https://jsonplaceholder.typicode.com/posts/${id}`).then((res) =>
    res.json(),
  ),
);

function App() {
  const [postId, setPostId] = useState(0);
  const { data, error, isLoading } = useSES(resource, [postId]);

  return (
    <>
      <div>
        <code>
          <pre>{JSON.stringify({ data, error, isLoading }, null, 2)}</pre>
        </code>

        <p>
          <code>Error: {String(error)}</code>
        </p>

        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setPostId((postId) => postId + 1)}>
          postId is {postId}
        </button>

        <button onClick={() => resource.mutate({ revalidateAll: true })}>
          Revalidate All
        </button>

        <button onClick={() => setPostId(0)}>Set postId to 0</button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  );
}

export default App;
