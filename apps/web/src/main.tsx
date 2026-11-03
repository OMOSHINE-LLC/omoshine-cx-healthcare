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
import { IcraPage } from './pages/Icra';
import { IlsmPage } from './pages/Ilsm';
import { MedGasPage } from './pages/MedGas';
import { SurveyBinderPage } from './pages/SurveyBinder';
import { IntegrationsPage } from './pages/Integrations';
import { DataExchangePage } from './pages/DataExchange';
import { LifeSafetyPage } from './pages/LifeSafety';

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
      <NavLink to={`${base}/icra`}>Infection control (ICRA)</NavLink>
      <NavLink to={`${base}/ilsm`}>Interim life safety</NavLink>
      <NavLink to={`${base}/life-safety`}>Life safety</NavLink>
      <NavLink to={`${base}/medgas`}>Medical gas</NavLink>
      <NavLink to={`${base}/binder`}>Survey binder</NavLink>
      <NavLink to={`${base}/data-exchange`}>Data exchange</NavLink>
      <NavLink to={`${base}/integrations`}>Integrations</NavLink>
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
                <Route path="icra" element={<IcraPage />} />
                <Route path="ilsm" element={<IlsmPage />} />
                <Route path="life-safety" element={<LifeSafetyPage />} />
                <Route path="medgas" element={<MedGasPage />} />
                <Route path="binder" element={<SurveyBinderPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="data-exchange" element={<DataExchangePage />} />
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
