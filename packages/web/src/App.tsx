import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { clearSession, getAuthor, getLoginUsername, setAuthor } from "./api";
import LoginPage from "./pages/LoginPage";
import Dashboard from "./pages/Dashboard";
import SpecsPage from "./pages/SpecsPage";
import SpecDetailPage from "./pages/SpecDetailPage";
import ReviewsPage from "./pages/ReviewsPage";
import ReviewDetailPage from "./pages/ReviewDetailPage";
import FeedbackPage from "./pages/FeedbackPage";
import ReportsPage from "./pages/ReportsPage";
import ProjectTypesPage from "./pages/ProjectTypesPage";
import SearchPage from "./pages/SearchPage";
import TemplatesPage from "./pages/TemplatesPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  const [author, setAuthorState] = useState(getAuthor());

  useEffect(() => {
    setAuthor(author);
  }, [author]);

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">
          <span className="dot" /> SpecRegistry
        </div>
        <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Dashboard
        </NavLink>
        <NavLink to="/specs" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Specifications
        </NavLink>
        <NavLink to="/reviews" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Reviews
        </NavLink>
        <NavLink to="/feedback" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          AI Feedback
        </NavLink>
        <NavLink to="/reports" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Reports
        </NavLink>
        <NavLink to="/search" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Search
        </NavLink>
        <NavLink to="/project-types" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Project Types
        </NavLink>
        <NavLink to="/templates" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Templates
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
          Settings
        </NavLink>
        <div className="spacer" />
        <div className="author-box">
          {getLoginUsername() ? (
            <>
              <label>Signed in</label>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="mono">{getLoginUsername()}</span>
                <button
                  onClick={() => {
                    clearSession();
                    window.location.href = "/";
                  }}
                >
                  Out
                </button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="author">Acting as</label>
              <input
                id="author"
                type="text"
                value={author}
                style={{ width: "100%" }}
                onChange={(e) => setAuthorState(e.target.value || "anonymous")}
              />
              <Link to="/login" className="faint" style={{ fontSize: 11 }}>
                Sign in →
              </Link>
            </>
          )}
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/specs" element={<SpecsPage />} />
          <Route path="/specs/:id" element={<SpecDetailPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/reviews/:id" element={<ReviewDetailPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/project-types" element={<ProjectTypesPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </main>
    </div>
  );
}
