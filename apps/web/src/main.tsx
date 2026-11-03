import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import './theme.css';
import { getToken, setToken } from './api';
import { DashboardPage, LoginPage, ProjectsPage } from './pages/Home';
import { RoomGridPage, RoomPage } from './pages/RoomCompliance';
import { EesPage } from './pages/Ees';
import { IssuesPage } from './pages/Issues';
import { TestRunPage, TestRunsPage } from './pages/TestRuns';

function ProjectNav() {
  const { projectId } = useParams();
  if (!projectId) return <nav className="nav" aria-label="Main"><NavLink to="/" end>Projects</NavLink></nav>;
  const base = `/projects/${projectId}`;
  return (
    <nav className="nav" aria-label="Project">
      <NavLink to="/" end>All projects</NavLink>
      <NavLink to={base} end>Readiness</NavLink>
      <NavLink to={`${base}/rooms`}>Room compliance</NavLink>
      <NavLink to={`${base}/ees`}>Essential electrical</NavLink>
      <NavLink to={`${base}/tests`}>Checklists and tests</NavLink>
      <NavLink to={`${base}/issues`}>Issues</NavLink>
    </nav>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  return (
    <>
      <header className="app-header">
        <img className="logo" src="/omoshine-logo.png" alt="OMOSHINE logo" />
        <span className="product">OMOSHINE CX Planner – Healthcare Edition</span>
        <span className="spacer" />
        <button onClick={onLogout}>Sign out</button>
      </header>
      <Routes>
        <Route path="/" element={<div className="layout"><ProjectNav /><main className="content"><ProjectsPage /></main></div>} />
        <Route path="/projects/:projectId/*" element={
          <div className="layout">
            <ProjectNav />
            <main className="content">
              <Routes>
                <Route index element={<DashboardPage />} />
                <Route path="rooms" element={<RoomGridPage />} />
                <Route path="rooms/:roomId" element={<RoomPage />} />
                <Route path="ees" element={<EesPage />} />
                <Route path="tests" element={<TestRunsPage />} />
                <Route path="tests/:runId" element={<TestRunPage />} />
                <Route path="issues" element={<IssuesPage />} />
              </Routes>
            </main>
          </div>
        } />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </>
  );
}

function App() {
  const [authed, setAuthed] = useState(!!getToken());
  return authed ? <Shell onLogout={() => { setToken(null); setAuthed(false); }} /> : <LoginPage onLogin={() => setAuthed(true)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
);
