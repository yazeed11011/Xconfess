import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';
import ProtectedRoute from './components/ProtectedRoute';
import UpdateBanner from './components/UpdateBanner';
import { clearUserScopedState } from './lib/userScopedState';
import JourneySignalsPage from './pages/JourneySignalsPage';
import TestFixtureRegistryPage from './pages/TestFixtureRegistryPage';
import ModerationQueueMetricsPage from './pages/ModerationQueueMetricsPage';

function AppRoutes() {
  const { user } = useAuth();
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    if (previousUserId.current !== null && previousUserId.current !== currentUserId) {
      // Account switch or logout: drop any user-scoped persisted content so
      // stale authenticated data cannot survive into the next session.
      clearUserScopedState();
    }
    previousUserId.current = currentUserId;
  }, [user?.id]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="ops/journey-signals" element={<JourneySignalsPage />} />
        <Route path="ops/moderation-queue" element={<ModerationQueueMetricsPage />} />
        <Route path="admin/testing-fixtures" element={<TestFixtureRegistryPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function ServiceWorkerUpdateGate() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationFailed, setActivationFailed] = useState(false);
  const reloadRequested = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    let cancelled = false;

    const trackRegistration = (registration: ServiceWorkerRegistration) => {
      if (cancelled) {
        return;
      }
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) {
          return;
        }
        installing.addEventListener('statechange', () => {
          if (
            installing.state === 'installed' &&
            navigator.serviceWorker.controller
          ) {
            setWaitingWorker(registration.waiting ?? installing);
          }
        });
      });
    };

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (registration) {
          trackRegistration(registration);
        }
      })
      .catch(() => {
        // Registration lookup failures are non-fatal; the app keeps working
        // without an update prompt.
      });

    const onControllerChange = () => {
      if (reloadRequested.current) {
        reloadRequested.current = false;
        window.location.reload();
      }
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const handleReload = useCallback(() => {
    if (!waitingWorker) {
      return;
    }
    setActivating(true);
    setActivationFailed(false);
    reloadRequested.current = true;

    const onStateChange = () => {
      if (waitingWorker.state === 'redundant') {
        waitingWorker.removeEventListener('statechange', onStateChange);
        reloadRequested.current = false;
        setActivating(false);
        setActivationFailed(true);
      }
    };
    waitingWorker.addEventListener('statechange', onStateChange);

    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      waitingWorker.removeEventListener('statechange', onStateChange);
      reloadRequested.current = false;
      setActivating(false);
      setActivationFailed(true);
    }
  }, [waitingWorker]);

  const handleDismiss = useCallback(() => {
    setWaitingWorker(null);
    setActivationFailed(false);
  }, []);

  if (!waitingWorker) {
    return null;
  }

  return (
    <UpdateBanner
      activating={activating}
      failed={activationFailed}
      onReload={handleReload}
      onDismiss={handleDismiss}
    />
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
          <ServiceWorkerUpdateGate />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
