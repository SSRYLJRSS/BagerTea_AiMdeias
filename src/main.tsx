import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { markStartup } from "./utils/startupMarks";

// 启动埋点（指导书 §4.1）：DOM 就绪（脚本为 deferred，模块执行即在 DOMContentLoaded 后）
markStartup("html_dom_content_loaded");
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// React 首帧：创建根后的同步段已进入 React 渲染管线（真实首帧时间由 App 内 effect 打点）
markStartup("react_first_render");