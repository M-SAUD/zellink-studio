import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownUp, ArrowRight, ArrowUpRight, Bell, BriefcaseBusiness, Check, ChevronDown, ClipboardCheck,
  ChevronRight, ChevronUp, Clock3, FileText, FolderKanban, Inbox, Layers3, LayoutGrid,
  LoaderCircle, MessageCircle, Paperclip, Plus, Search,
  Send, ShieldCheck, Sparkles, Users, X,
} from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { StudioSidebar, type StudioNavigationItem } from "@/components/studio-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog as AccessibleDialog, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type GlobalRole = "client" | "pm" | "specialist" | "admin" | "super_admin";
type Actor = { id: string; email: string; displayName: string; globalRole: GlobalRole; mustChangePassword: boolean };
type Organization = {
  id: string; name: string; status: string; industry?: string | null; website_url?: string | null;
  primary_pm?: string | null; primary_pm_email?: string | null; primary_pm_user_id?: string | null; plan_id?: string | null; plan_name?: string | null;
  included_lanes?: number | null; extra_lanes?: number | null; billing_period?: "monthly" | "annual" | null; subscription_state?: string | null;
  active_lanes?: number | null; queued_requests?: number | null; needs_review?: number | null; onboarding_status?: string | null;
  client_role?: string; can_submit?: number; can_approve?: number; can_manage_members?: number;
  awaiting_review?: number; waiting_on_client?: number; active_work?: number; onboarding_review?: number;
};
type Session = { authenticated: boolean; actor?: Actor; organizations?: Organization[] };
type Dashboard = Record<string, unknown> & { role?: string; organizations?: Organization[]; tasks?: Task[]; requestStatuses?: { status: string; count: number }[]; integrations?: Integration[]; onboarding?: { status: string; count: number }[] };
type Project = { id: string; name: string; summary: string; state: string; request_count?: number };
type Request = {
  id: string; organizationId: string; projectId: string; projectName: string; title: string; summary: string;
  objective: string; serviceType: string | null; status: string; version: number; priority: string;
  desiredTiming: string | null; references: string[]; queuePosition: number; createdByName: string;
  createdAt: string; updatedAt: string; laneNumber: number | null; activeTaskCount: number;
};
type Task = { id: string; organization_id: string; organization_name: string; request_id: string; request_title: string; request_summary: string; objective: string; approved_brief: string | null; latest_feedback: string | null; title: string; internal_scope: string; status: string; block_reason?: string | null };
type Comment = { id: string; body: string; visibility: "client" | "internal"; author_name: string; created_at: string };
type Brief = { id: string; version_number: number; content: string; is_first_brief: number; approval_id: string | null; approval_state: string | null; decision_note: string | null; created_by_name: string };
type Approval = { id: string; approval_kind: "first_brief" | "deliverable" | "other"; state: string; decision_note: string | null; submitted_version: number; status: string; version: number };
type StoredFile = { id: string; original_name: string; media_type: string; byte_size: number; scan_state: string; client_visible: number; uploader_name: string; created_at: string };
type Notification = { id: string; title: string; body: string; read_at: string | null; created_at: string; organization_id: string | null; request_id: string | null };
type Integration = { provider_key: string; configured: number; status: string; status_detail: string | null };
type OnboardingFile = { id: string; original_name: string; media_type: string; byte_size: number; scan_state: string; created_at: string; uploader_name: string };
type Onboarding = { id: string; status: string; answers: Record<string, unknown>; checklist: Record<string, boolean>; reviewedBy: string | null; files: OnboardingFile[] };
type StaffMember = { id: string; email: string; display_name: string; global_role: string; disabled_at: string | null };
type PasswordResetTarget = Pick<StaffMember, "id" | "email" | "display_name">;
type TeamMember = { id: string; email: string; display_name: string; client_role: "owner" | "member"; can_submit: number; can_approve: number; can_manage_members: number; joined_at: string };
type DetailData = { comments: Comment[]; briefs: Brief[]; approvals: Approval[]; files: StoredFile[]; events: { event_type: string; from_status: string | null; to_status: string | null; reason: string | null; created_at: string }[] };
type ModalState = { title: string; description?: string; content: React.ReactNode; onClose?: () => void } | null;

const DEMO_USERS = [
  { id: "demo-client-owner", label: "Client owner", name: "Jordan Lee" },
  { id: "demo-pm", label: "Project manager", name: "Avery Chen" },
  { id: "demo-specialist", label: "Specialist", name: "Samir Patel" },
  { id: "demo-admin", label: "Admin", name: "Morgan Lane" },
  { id: "demo-super-admin", label: "Super admin", name: "Alex Morgan" },
];

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, typeof body.error === "string" ? body.error : `request_failed_${response.status}`);
  return body as T;
}

function json(method: string, data?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) };
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [view, setView] = useState("overview");
  const [modal, setModal] = useState<ModalState>(null);
  const [detail, setDetail] = useState<{ request: Request; data: DetailData } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [fileUploadsEnabled, setFileUploadsEnabled] = useState(false);
  const actor = session?.actor;
  const selectedOrganization = organizations.find((org) => org.id === selectedOrgId) ?? null;
  const isDemo = Boolean(actor?.email.endsWith("@example.test"));
  const unreadCount = notifications.filter((notification) => !notification.read_at).length;

  useEffect(() => {
    let live = true;
    void api<{ mode: string; fileUploadsEnabled: boolean }>("/api/health")
      .then((status) => {
        if (!live) return;
        setFileUploadsEnabled(status.fileUploadsEnabled);
        setDemoAvailable(status.mode === "development");
      })
      .catch(() => {
        if (!live) return;
        setFileUploadsEnabled(false);
        setDemoAvailable(false);
      });
    return () => { live = false; };
  }, []);

  const refreshSession = useCallback(async (preferredId?: string) => {
    const current = await api<Session>("/api/auth/session");
    setSession(current);
    if (!current.authenticated || !current.actor) {
      setOrganizations([]); setDashboard(null); setNotifications([]); setSelectedOrgId("");
      return;
    }
    const [orgs, dash, inbox] = await Promise.all([
      api<{ organizations: Organization[] }>("/api/organizations"),
      api<{ dashboard: Dashboard }>("/api/dashboard"),
      api<{ notifications: Notification[] }>("/api/notifications"),
    ]);
    const dashboardOrgs = Array.isArray(dash.dashboard.organizations) ? dash.dashboard.organizations : [];
    const mergedOrganizations = orgs.organizations.map((org) => ({
      ...org,
      ...(dashboardOrgs.find((item) => item.id === org.id) ?? {}),
    }));
    setOrganizations(mergedOrganizations);
    setDashboard(dash.dashboard);
    setNotifications(inbox.notifications);
    setTasks(dash.dashboard.tasks ?? []);
    const nextId = preferredId && mergedOrganizations.some((org) => org.id === preferredId)
      ? preferredId
      : selectedOrgId && mergedOrganizations.some((org) => org.id === selectedOrgId)
        ? selectedOrgId : mergedOrganizations[0]?.id ?? "";
    setSelectedOrgId(nextId);
  }, [selectedOrgId]);

  const refreshOrganization = useCallback(async (organizationId = selectedOrgId) => {
    if (!organizationId || !actor) { setProjects([]); setRequests([]); setOnboarding(null); return; }
    const requestPromise = actor.globalRole === "pm" || actor.globalRole === "specialist"
      ? Promise.all(organizations.map((org) => api<{ requests: Request[] }>(`/api/orgs/${org.id}/requests`))).then((items) => ({ requests: items.flatMap((item) => item.requests) }))
      : api<{ requests: Request[] }>(`/api/orgs/${organizationId}/requests`);
    const memberPromise = actor.globalRole === "client" || actor.globalRole === "admin" || actor.globalRole === "super_admin"
      ? api<{ members: TeamMember[] }>(`/api/orgs/${organizationId}/members`).then((result) => setMembers(result.members)).catch(() => setMembers([]))
      : Promise.resolve();
    const tasksPromise = actor.globalRole === "pm" || actor.globalRole === "specialist" || actor.globalRole === "admin" || actor.globalRole === "super_admin"
      ? api<{ tasks: Task[] }>("/api/tasks").then((result) => setTasks(result.tasks)).catch(() => setTasks([]))
      : Promise.resolve();
    const [projectResult, requestResult, onboardingResult] = await Promise.all([
      api<{ projects: Project[] }>(`/api/orgs/${organizationId}/projects`),
      requestPromise,
      api<{ onboarding: Onboarding }>(`/api/orgs/${organizationId}/onboarding`).catch(() => ({ onboarding: null as unknown as Onboarding })),
      memberPromise,
      tasksPromise,
    ]);
    setProjects(projectResult.projects);
    setRequests(requestResult.requests);
    setOnboarding(onboardingResult.onboarding);
  }, [actor, organizations, selectedOrgId]);

  useEffect(() => {
    let live = true;
    void api<Session>("/api/auth/session").then(async (current) => {
      if (!live) return;
      if (!current.authenticated) { setSession(current); setLoading(false); return; }
      setSession(current);
      await refreshSession();
      if (live) setLoading(false);
    }).catch((cause: unknown) => {
      if (live) { setError(errorMessage(cause)); setLoading(false); }
    });
    return () => { live = false; };
  }, [refreshSession]);

  useEffect(() => {
    if (!actor || !selectedOrgId) return;
    void refreshOrganization(selectedOrgId).catch((cause: unknown) => setError(errorMessage(cause)));
  }, [actor, selectedOrgId, refreshOrganization]);

  useEffect(() => {
    if (view !== "team" || (actor?.globalRole !== "admin" && actor?.globalRole !== "super_admin")) return;
    void api<{ users: StaffMember[] }>("/api/admin/users")
      .then((result) => setStaff(result.users.filter((user) => user.global_role !== "client")))
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [view, actor?.globalRole]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const withBusy = async (action: () => Promise<void>, success?: string) => {
    setSaving(true); setError("");
    try { await action(); if (success) setToast(success); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void withBusy(async () => {
      await api("/api/auth/login", json("POST", { email: form.get("email"), password: form.get("password") }));
      await refreshSession(); setLoading(false);
    });
  };

  const signInDemo = async (userId: string) => {
    await withBusy(async () => {
      await api("/api/auth/demo", json("POST", { userId }));
      await refreshSession(); setLoading(false);
      setToast("Fictional demo workspace loaded");
    });
  };

  const logout = () => void withBusy(async () => {
    await api("/api/auth/logout", json("POST"));
    setSession({ authenticated: false }); setOrganizations([]); setSelectedOrgId(""); setDashboard(null);
    setRequests([]); setProjects([]); setTasks([]); setOnboarding(null); setDetail(null);
  });

  const openRequest = async (request: Request) => {
    setSaving(true); setError("");
    try {
      const [comments, briefs, approvals, files, events] = await Promise.all([
        api<{ comments: Comment[] }>(`/api/orgs/${request.organizationId}/requests/${request.id}/comments`),
        api<{ briefs: Brief[] }>(`/api/orgs/${request.organizationId}/requests/${request.id}/briefs`),
        api<{ approvals: Approval[]; request: { version: number } }>(`/api/orgs/${request.organizationId}/requests/${request.id}/approvals`),
        api<{ files: StoredFile[] }>(`/api/orgs/${request.organizationId}/requests/${request.id}/files`),
        api<{ events: DetailData["events"] }>(`/api/orgs/${request.organizationId}/requests/${request.id}/events`),
      ]);
      setDetail({ request, data: { comments: comments.comments, briefs: briefs.briefs, approvals: approvals.approvals, files: files.files, events: events.events } });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const reloadDetail = async () => {
    if (!detail) return;
    const request = requests.find((item) => item.id === detail.request.id) ?? detail.request;
    await openRequest(request);
  };

  const createRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrgId) return;
    const form = new FormData(event.currentTarget);
    const submitButton = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    void withBusy(async () => {
      await api(`/api/orgs/${selectedOrgId}/requests`, json("POST", {
        projectId: form.get("projectId"), title: form.get("title"), summary: form.get("summary"),
        objective: form.get("objective"), serviceType: form.get("serviceType"), priority: form.get("priority"),
        desiredTiming: form.get("desiredTiming"), references: String(form.get("references") ?? "").trim() ? [String(form.get("references")).trim()] : [], submit: submitButton?.value !== "false",
      }));
      setModal(null); await refreshOrganization(); await refreshSession();
    }, "Request submitted");
  };

  const createProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedOrgId) return;
    const form = new FormData(event.currentTarget);
    void withBusy(async () => {
      await api(`/api/orgs/${selectedOrgId}/projects`, json("POST", { name: form.get("name"), summary: form.get("summary") }));
      setModal(null); await refreshOrganization();
    }, "Project created");
  };

  const createOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void withBusy(async () => {
      const result = await api<{ organization: { id: string }; temporaryPassword?: string; owner: { email: string } }>("/api/admin/organizations", json("POST", {
        name: form.get("name"), ownerEmail: form.get("ownerEmail"), ownerDisplayName: form.get("ownerDisplayName"),
        industry: form.get("industry"), websiteUrl: form.get("websiteUrl"), timezone: form.get("timezone"),
        primaryPmUserId: form.get("primaryPmUserId"), planId: form.get("planId"), extraLanes: Number(form.get("extraLanes") || 0),
        billingPeriod: form.get("billingPeriod") || null, subscriptionState: form.get("subscriptionState"),
        reason: form.get("reason"), paymentNote: form.get("paymentNote"),
      }));
      setModal({ title: "Client organization created", description: `The account for ${result.owner.email} is ready.`, content: result.temporaryPassword
        ? <OneTimeSecret password={result.temporaryPassword} label="Temporary password" onDone={() => setModal(null)} />
        : <div className="modal-note">This owner already has an account. No password was created.</div> });
      await refreshSession(result.organization.id);
    }, "Client organization created");
  };

  const addMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedOrgId) return;
    const form = new FormData(event.currentTarget);
    void withBusy(async () => {
      const result = await api<{ member: { email: string }; temporaryPassword?: string }>(`/api/orgs/${selectedOrgId}/members`, json("POST", {
        email: form.get("email"), displayName: form.get("displayName"), canSubmit: form.get("canSubmit") === "on",
        canApprove: form.get("canApprove") === "on", canManageMembers: false,
      }));
      setModal({ title: "Member added", description: result.member.email, content: result.temporaryPassword
        ? <OneTimeSecret password={result.temporaryPassword} label="Temporary password" onDone={() => setModal(null)} />
        : <div className="modal-note">This person already had an account. They can use their current password.</div> });
      await refreshOrganization();
    }, "Member added");
  };

  const createStaff = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void withBusy(async () => {
      const result = await api<{ user: { email: string; role: string }; temporaryPassword: string }>("/api/admin/users", json("POST", { email: form.get("email"), displayName: form.get("displayName"), role: form.get("role") }));
      setModal({ title: "Staff account created", description: `${result.user.email} · ${roleLabel(result.user.role as GlobalRole)}`, content: <OneTimeSecret password={result.temporaryPassword} label="Temporary password" onDone={() => setModal(null)} /> });
      const users = await api<{ users: typeof staff }>("/api/admin/users"); setStaff(users.users);
    }, "Staff account created");
  };

  const transitionRequest = async (request: Request, toStatus: string, reason = "") => {
    await withBusy(async () => {
      await api(`/api/orgs/${request.organizationId}/requests/${request.id}/transition`, json("POST", { toStatus, expectedVersion: request.version, reason }));
      await refreshOrganization(request.organizationId); await refreshSession(request.organizationId);
      setToast(`Moved to ${statusLabel(toStatus).toLowerCase()}`);
    });
  };

  const reorderQueuedRequest = async (requestId: string, targetIndex: number, organizationId: string) => {
    const queue = requests.filter((request) => request.organizationId === organizationId && request.status === "queued")
      .sort((left, right) => left.queuePosition - right.queuePosition);
    const currentIndex = queue.findIndex((request) => request.id === requestId);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= queue.length || currentIndex === targetIndex) return;
    const requestIds = queue.map((request) => request.id);
    const [moved] = requestIds.splice(currentIndex, 1);
    requestIds.splice(targetIndex, 0, moved!);
    await withBusy(async () => {
      await api(`/api/orgs/${organizationId}/requests/reorder`, json("POST", { requestIds }));
      await refreshOrganization(organizationId);
    }, "Queue updated");
  };

  const updateEntitlement = async (organizationId: string, payload: unknown) => {
    await withBusy(async () => {
      await api(`/api/admin/orgs/${organizationId}/entitlement`, json("PATCH", payload));
      await refreshSession(organizationId);
    }, "Plan records updated");
  };

  const updateOrganizationStatus = async (organizationId: string, payload: unknown) => {
    await withBusy(async () => {
      await api(`/api/admin/orgs/${organizationId}/status`, json("PATCH", payload));
      await refreshSession(organizationId);
    }, "Organization status updated");
  };

  const assignPrimaryPm = async (organizationId: string, payload: unknown) => {
    await withBusy(async () => {
      await api(`/api/admin/orgs/${organizationId}/pm-assignments`, json("POST", { ...payload as object, assignmentRole: "primary" }));
      await refreshSession(organizationId);
    }, "Primary project manager assigned");
  };

  const assignBackupPm = async (organizationId: string, payload: unknown) => {
    await withBusy(async () => {
      await api(`/api/admin/orgs/${organizationId}/pm-assignments`, json("POST", { ...payload as object, assignmentRole: "backup" }));
      await refreshSession(organizationId);
    }, "Temporary backup PM assigned");
  };

  const endBackupPm = async (organizationId: string, payload: unknown) => {
    await withBusy(async () => {
      await api(`/api/admin/orgs/${organizationId}/pm-assignments/backup/end`, json("POST", payload));
      await refreshSession(organizationId);
    }, "Backup PM assignment ended");
  };

  const saveOnboarding = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedOrgId) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const answers = Object.fromEntries(["companyName", "mainContact", "website", "businessGoals", "priorities", "brandAssets", "communicationPreferences", "existingTools"].map((key) => [key, String(form.get(key) ?? "").trim()]));
    void withBusy(async () => {
      await api(`/api/orgs/${selectedOrgId}/onboarding`, json("PUT", { answers, submit: submitter?.value === "true" }));
      await refreshOrganization(); await refreshSession();
    }, submitter?.value === "true" ? "Onboarding sent to your project manager" : "Onboarding saved");
  };

  const uploadOnboardingFile = (file: File) => {
    if (!selectedOrgId) return;
    void withBusy(async () => {
      const body = new FormData(); body.append("file", file);
      await api(`/api/orgs/${selectedOrgId}/onboarding/files`, { method: "POST", body });
      await refreshOrganization();
    }, "File uploaded for security scanning");
  };

  const downloadOnboardingFile = (fileId: string, name: string) => {
    if (!selectedOrgId) return;
    void withBusy(async () => {
      const response = await fetch(`/api/orgs/${selectedOrgId}/onboarding/files/${fileId}/download`, { credentials: "same-origin" });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new ApiError(response.status, body.error ?? "download_failed"); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "Download started");
  };

  const saveOnboardingChecklist = async (checklist: Record<string, boolean>) => {
    if (!selectedOrgId) return;
    await withBusy(async () => {
      await api(`/api/orgs/${selectedOrgId}/onboarding`, json("PUT", { checklist }));
      await refreshOrganization(); await refreshSession();
    }, "Checklist saved for review");
  };

  const completeOnboarding = async () => {
    if (!selectedOrgId) return;
    await withBusy(async () => {
      await api(`/api/orgs/${selectedOrgId}/onboarding/complete`, json("POST"));
      await refreshOrganization(); await refreshSession(); setModal(null);
    }, "Onboarding completed");
  };

  const renderView = () => {
    if (!actor) return null;
    if (actor.mustChangePassword) return <PasswordChange actor={actor} onDone={() => void refreshSession()} />;
    if (actor.globalRole === "specialist") return <SpecialistView tasks={tasks} requests={requests} onOpen={openRequest} onChange={async (task, status, blockReason) => {
      await withBusy(async () => {
        await api(`/api/orgs/${task.organization_id}/tasks/${task.id}`, json("PATCH", { status, blockReason }));
        const result = await api<{ tasks: Task[] }>("/api/tasks"); setTasks(result.tasks);
      }, "Task updated");
    }} />;
    if (view === "inbox") return <InboxView notifications={notifications} onRead={async (notification) => {
      await withBusy(async () => {
        await api(`/api/notifications/${notification.id}/read`, json("POST"));
        setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item));
      });
    }} onReadAll={async () => {
      await withBusy(async () => { await api("/api/notifications/read-all", json("POST")); setNotifications((items) => items.map((item) => ({ ...item, read_at: new Date().toISOString() }))); }, "Inbox cleared");
    }} />;
    if (view === "team") return <TeamView actor={actor} organization={selectedOrganization} members={members} staff={staff} onAddMember={() => setModal({ title: "Add a client member", description: "Members get their own sign-in and organization access.", content: <MemberForm onSubmit={addMember} /> })} onCreateStaff={() => void loadStaffDirectory()} onToggleStaff={manageStaffAccess} onResetPassword={resetStaffPassword} />;
    if (view === "projects") return <ProjectsView projects={projects} requests={requests} actor={actor} onCreate={() => setModal({ title: "Create a project", content: <ProjectForm onSubmit={createProject} /> })} onOpen={openRequest} />;
    if (view === "requests") return <RequestsView actor={actor} organization={selectedOrganization} requests={actor.globalRole === "pm" ? requests.filter((request) => request.organizationId === selectedOrgId) : requests} projects={projects} onCreate={() => setModal({ title: "New request", description: "Tell your project manager what you’re working toward.", content: <RequestForm projects={projects} onSubmit={createRequest} /> })} onOpen={openRequest} onTransition={transitionRequest} onReorder={(requestId, targetIndex, organizationId) => void reorderQueuedRequest(requestId, targetIndex, organizationId)} />;
    if (actor.globalRole === "admin" || actor.globalRole === "super_admin") return <AdminView dashboard={dashboard} organizations={organizations} organization={selectedOrganization} integrations={(dashboard?.integrations ?? []) as Integration[]} onCreate={() => void loadStaffAndOpen()} onSelect={setSelectedOrgId} onUpdateEntitlement={updateEntitlement} onChangeStatus={updateOrganizationStatus} onAssignPrimaryPm={assignPrimaryPm} onAssignBackupPm={assignBackupPm} onEndBackupPm={endBackupPm} />;
    if (actor.globalRole === "pm") return <PmView organizations={organizations} requests={requests} tasks={tasks} onboarding={onboarding} onReviewOnboarding={() => setModal({ title: "Review onboarding", description: selectedOrganization?.name, content: onboarding ? <OnboardingReviewForm onboarding={onboarding} onSave={saveOnboardingChecklist} onComplete={completeOnboarding} onUploadFile={uploadOnboardingFile} onDownloadFile={downloadOnboardingFile} /> : <CompactEmpty title="Onboarding is not available" copy="Refresh the organization record and try again." /> })} onUploadOnboardingFile={uploadOnboardingFile} onDownloadOnboardingFile={downloadOnboardingFile} onSelect={setSelectedOrgId} onOpen={openRequest} onCreateProject={() => setModal({ title: "Create a project", content: <ProjectForm onSubmit={createProject} /> })} onCreateRequest={() => setModal({ title: "Prepare an initial request", content: <RequestForm projects={projects} onSubmit={createRequest} /> })} onTransition={transitionRequest} />;
    return <ClientView organization={selectedOrganization} projects={projects} requests={requests} onboarding={onboarding} onSaveOnboarding={saveOnboarding} onUploadOnboardingFile={uploadOnboardingFile} onDownloadOnboardingFile={downloadOnboardingFile} onCreateRequest={() => setModal({ title: "New request", description: "Tell your project manager what you’re working toward.", content: <RequestForm projects={projects} onSubmit={createRequest} /> })} onOpen={openRequest} onSelectView={setView} />;
  };

  async function loadStaffAndOpen() {
    try {
      const [pmResult, specialistResult] = await Promise.all([
        api<{ users: typeof staff }>("/api/admin/users?role=pm"),
        api<{ users: typeof staff }>("/api/admin/users?role=specialist"),
      ]);
      setStaff([...pmResult.users, ...specialistResult.users]);
      setModal({ title: "Add a client", description: "A Zellink admin stays responsible for the first setup.", content: <OrganizationForm users={pmResult.users} onSubmit={createOrganization} /> });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function loadStaffDirectory() {
    try {
      const result = await api<{ users: StaffMember[] }>("/api/admin/users");
      setStaff(result.users.filter((user) => user.global_role !== "client"));
    } catch (cause) { setError(errorMessage(cause)); return; }
    setModal({ title: "Create a staff account", description: "The new team member will choose a personal password on first sign-in.", content: <StaffForm role={actor?.globalRole ?? "admin"} onSubmit={createStaff} /> });
  }

  const manageStaffAccess = (member: StaffMember) => {
    const disabled = !member.disabled_at;
    setModal({
      title: disabled ? "Suspend account access" : "Restore account access",
      description: `${member.display_name} · ${member.email}`,
      content: <AccountAccessForm disabled={disabled} onSubmit={(reason) => {
        void withBusy(async () => {
          await api(`/api/admin/users/${member.id}/access`, json("PATCH", { disabled, reason }));
          const result = await api<{ users: StaffMember[] }>("/api/admin/users");
          setStaff(result.users.filter((user) => user.global_role !== "client"));
          setModal(null);
          await refreshSession();
        }, disabled ? "Account access suspended" : "Account access restored");
      }} />,
    });
  };

  const resetStaffPassword = (member: PasswordResetTarget) => {
    setModal({
      title: "Reset password",
      description: `${member.display_name} · ${member.email}`,
      content: <ResetPasswordForm onSubmit={(reason) => {
        void withBusy(async () => {
          const result = await api<{ temporaryPassword: string }>(`/api/admin/users/${member.id}/reset-password`, json("POST", { reason }));
          setModal({ title: "Password reset", description: `${member.display_name} must choose a new password at sign-in.`, content: <OneTimeSecret password={result.temporaryPassword} label="Temporary password" onDone={() => setModal(null)} /> });
        }, "Password reset");
      }} />,
    });
  };

  const openNotifications = () => { setView("inbox"); };

  if (loading) return <div className="loading-screen"><span className="brand-mark">Z</span><LoaderCircle className="spin" size={22} aria-label="Loading workspace" /></div>;
  if (!actor) return <SignIn onSubmit={signIn} onDemo={signInDemo} demoAvailable={demoAvailable} setDemoAvailable={setDemoAvailable} saving={saving} error={error} />;

  const navItems: StudioNavigationItem[] = actor.globalRole === "specialist"
    ? [{ id: "overview", label: "My assignments", icon: BriefcaseBusiness }]
    : [
      { id: "overview", label: "Overview", icon: LayoutGrid },
      { id: "requests", label: actor.globalRole === "pm" ? "Queue" : "Requests", icon: Inbox, ...(actor.globalRole === "pm" && requests.filter((request) => request.status === "submitted").length > 0 ? { badge: String(requests.filter((request) => request.status === "submitted").length) } : {}) },
      { id: "projects", label: "Projects", icon: FolderKanban },
      ...(actor.globalRole === "admin" || actor.globalRole === "super_admin" ? [{ id: "team", label: "Team", icon: Users }] : actor.globalRole === "client" ? [{ id: "team", label: "Your team", icon: Users }] : []),
    ];
  const inboxBadge = unreadCount > 0 ? unreadCount > 9 ? "9+" : String(unreadCount) : undefined;

  return (
    <SidebarProvider className="app-shell studio-app-shell" style={{ "--sidebar-width": "14rem" } as React.CSSProperties}>
      <StudioSidebar
        navigation={navItems}
        activeView={view}
        inboxBadge={inboxBadge}
        organizations={organizations}
        selectedOrganizationId={selectedOrgId}
        showOrganizationPicker={actor.globalRole !== "specialist"}
        actorName={actor.displayName}
        actorInitials={initials(actor.displayName)}
        actorRole={roleLabel(actor.globalRole)}
        onSelectView={setView}
        onSelectOrganization={setSelectedOrgId}
        onOpenReleaseNotes={() => setModal({ title: "Release notes", content: <div className="modal-note">Notifications stay in the app. Email and Slack are not configured. Client records are retained permanently; export and deletion actions are unavailable.</div> })}
        onSignOut={logout}
      />

      <SidebarInset className="content-column">
        <header className="topbar"><div className="topbar-leading"><SidebarTrigger className="menu-toggle" aria-label="Toggle navigation" /><span className="crumb">Zellink Studio <ChevronRight size={13} /> <strong>{navItems.find((item) => item.id === view)?.label ?? (view === "inbox" ? "Inbox" : "Overview")}</strong></span></div><div className="topbar-actions"><label className="search-box"><Search size={16} /><input aria-label="Search workspace" placeholder="Search workspace" onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }} /><kbd>⌘ K</kbd></label><button className="icon-button notification-button" aria-label={`Open inbox, ${unreadCount} unread`} onClick={openNotifications}><Bell size={18} />{unreadCount > 0 && <i />}</button><div className="avatar top-avatar" title={actor.displayName}>{initials(actor.displayName)}</div></div></header>
        <div className="main-content">
          {isDemo && <div className="demo-banner"><Sparkles size={15} /><span>Fictional demo workspace</span><span className="demo-divider">·</span><span>Records shown here are synthetic.</span></div>}
          {!fileUploadsEnabled && <div className="notice-banner" role="status"><span className="notice-icon"><ShieldCheck size={17} /></span><div><strong>File uploads are paused</strong><p>They’ll be available after malware scanning is configured.</p></div></div>}
          {error && <div className="alert alert-error" role="alert"><span><strong>We couldn’t finish that action.</strong> {humanError(error)}</span><button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
          {renderView()}
          <footer className="page-footer"><span>Made for clearer client work.</span><span>{selectedOrganization?.name ?? "Zellink Studio"} <span className="footer-dot">·</span> {new Date().getFullYear()}</span></footer>
        </div>
      </SidebarInset>

      {modal && <Modal key={modal.title} title={modal.title} description={modal.description} onClose={() => { modal.onClose?.(); setModal(null); }}>{modal.content}</Modal>}
      {detail && <RequestDetail request={detail.request} data={detail.data} role={actor.globalRole} saving={saving} onClose={() => { setDetail(null); setModal(null); }} onRefresh={async () => { await refreshOrganization(); await refreshSession(); await reloadDetail(); }} onAction={withBusy} setToast={setToast} />}
      {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
      {saving && <div className="busy-indicator" aria-label="Saving"><LoaderCircle size={16} className="spin" /></div>}
    </SidebarProvider>
  );

  function OrganizationForm({ users, onSubmit }: { users: { id: string; display_name: string; email: string }[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
    return <form className="form-grid" onSubmit={onSubmit}>
      <FormField label="Organization name"><Input name="name" required minLength={2} placeholder="e.g. Northstar Studio" /></FormField>
      <div className="field-row"><FormField label="Owner name"><Input name="ownerDisplayName" required placeholder="Name" /></FormField><FormField label="Owner email"><Input name="ownerEmail" type="email" required placeholder="name@company.com" /></FormField></div>
      <FormField label="Primary project manager"><select name="primaryPmUserId" required defaultValue=""><option value="" disabled>Select a PM</option>{users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select></FormField>
      <div className="field-row"><FormField label="Plan"><select name="planId" defaultValue="foundation"><option value="foundation">Foundation · 1 lane</option><option value="growth">Growth · 2 lanes</option><option value="scale">Scale · 3 lanes</option></select></FormField><FormField label="Extra lanes"><Input name="extraLanes" type="number" min="0" step="1" defaultValue="0" /></FormField></div>
      <div className="field-row"><FormField label="Billing period"><select name="billingPeriod" defaultValue=""><option value="">Not recorded</option><option value="monthly">Monthly</option><option value="annual">Annual</option></select></FormField><FormField label="Plan state"><select name="subscriptionState" defaultValue="pending"><option value="pending">Pending</option><option value="active">Active</option><option value="paused">Paused</option></select></FormField></div>
      <div className="field-row"><FormField label="Industry"><Input name="industry" placeholder="Optional" /></FormField><FormField label="Website"><Input name="websiteUrl" type="url" placeholder="https://" /></FormField></div>
      <FormField label="Reason for setup"><Textarea name="reason" required minLength={3} placeholder="This is recorded in the organization history." /></FormField>
      <FormField label="Manual payment note"><Input name="paymentNote" placeholder="Optional · never treated as verified payment" /></FormField>
      <p className="form-footnote"><ShieldCheck size={14} />No charge is created. Billing and payments are recorded manually.</p>
      <Button type="submit" disabled={saving}>Create organization <ArrowRight size={15} /></Button>
    </form>;
  }
}

function SignIn({ onSubmit, onDemo, demoAvailable, setDemoAvailable, saving, error }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; onDemo: (id: string) => Promise<void>; demoAvailable: boolean; setDemoAvailable: (value: boolean) => void; saving: boolean; error: string }) {
  const [showDemos, setShowDemos] = useState(true);
  const tryDemo = async (id: string) => {
    try { await onDemo(id); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 404) { setDemoAvailable(false); setShowDemos(false); } }
  };
  return <div className="signin-shell"><div className="signin-brand"><span className="brand-mark">Z</span><span>Zellink <b>Studio</b></span></div><div className="signin-layout"><div className="signin-copy"><div className="eyebrow"><span className="eyebrow-line" /> A calmer way to move work forward</div><h1>Good work starts<br />with <em>clarity.</em></h1><p>A shared space for client requests, thoughtful briefs, creative work and the decisions that bring it together.</p><div className="signin-detail"><div className="avatar-stack"><span>J</span><span>A</span><span>S</span></div><span>Clients, project managers<br />and creative partners.</span></div><div className="signin-orbit orbit-one" /><div className="signin-orbit orbit-two" /></div><div className="signin-card"><div className="signin-card-heading"><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your studio</h2><p>Use the email and password shared with you.</p></div><form onSubmit={onSubmit} className="signin-form"><FormField label="Email address"><Input type="email" name="email" autoComplete="username" required placeholder="you@company.com" /></FormField><FormField label="Password"><Input type="password" name="password" autoComplete="current-password" required placeholder="Your password" /></FormField>{error && <div className="form-error" role="alert">{humanError(error)}</div>}<Button type="submit" disabled={saving} className="signin-submit">{saving ? "Signing in…" : "Sign in"}<ArrowRight size={16} /></Button></form><div className="signin-privacy"><ShieldCheck size={15} /><span>Your organization’s work stays private to its members.</span></div>{demoAvailable && showDemos && <div className="demo-login"><div className="demo-login-heading"><span>LOCAL PREVIEW</span><button className="text-button" onClick={() => setShowDemos(false)}>Hide</button></div><p>Explore the fictional sample workspace as a different role.</p><div className="demo-roles">{DEMO_USERS.map((user) => <button key={user.id} onClick={() => void tryDemo(user.id)} disabled={saving}><span className="avatar mini-avatar">{initials(user.name)}</span><span><strong>{user.label}</strong><small>{user.name}</small></span><ArrowUpRight size={14} /></button>)}</div></div>}</div></div><footer className="signin-footer"><span>Violet Bloom <span>·</span> Zellink Studio</span><span>Private by design</span></footer></div>;
}

function ClientView({ organization, projects, requests, onboarding, onSaveOnboarding, onUploadOnboardingFile, onDownloadOnboardingFile, onCreateRequest, onOpen, onSelectView }: { organization: Organization | null; projects: Project[]; requests: Request[]; onboarding: Onboarding | null; onSaveOnboarding: (event: FormEvent<HTMLFormElement>) => void; onUploadOnboardingFile: (file: File) => void; onDownloadOnboardingFile: (fileId: string, name: string) => void; onCreateRequest: () => void; onOpen: (request: Request) => void; onSelectView: (view: string) => void }) {
  if (!organization) return <EmptyState title="Your studio is getting ready" copy="A Zellink admin will set up your organization and introduce your project manager." />;
  const attention = requests.filter((request) => request.status === "client_review" || request.status === "brief_ready");
  const active = requests.filter((request) => ["in_progress", "internal_review", "client_review"].includes(request.status));
  const queued = requests.filter((request) => request.status === "queued");
  const capacity = (organization.included_lanes ?? 0) + (organization.extra_lanes ?? 0);
  const onboardingPending = !onboarding || onboarding.status !== "complete";
  return <>
    <PageHeading eyebrow={`GOOD ${timeOfDay()}, ${organization.name.toUpperCase()}`} title="A clear view of what’s moving." copy="Your work, feedback and next steps, all in one place." action={<Button onClick={onCreateRequest} disabled={organization.subscription_state === "paused" || onboardingPending}><Plus size={16} /> New request</Button>} />
    {organization.subscription_state === "paused" && <div className="notice-banner pause-banner"><span className="notice-icon"><Clock3 size={17} /></span><div><strong>Your plan is paused</strong><p>You can follow current work and share feedback. New requests and lane starts are paused until your plan is active again.</p></div></div>}
    {onboardingPending && onboarding && <OnboardingCard onboarding={onboarding} onSave={onSaveOnboarding} />}
    {onboardingPending && !onboarding && <div className="notice-banner"><span className="notice-icon"><ClipboardCheck size={17} /></span><div><strong>Onboarding is not available yet</strong><p>Your project manager will help complete setup before new requests can begin.</p></div></div>}
    {onboarding && <OnboardingFiles files={onboarding.files} onUploadFile={onUploadOnboardingFile} onDownloadFile={onDownloadOnboardingFile} />}
    <div className="stat-grid client-stats"><StatCard label="Active lanes" value={`${organization.active_lanes ?? active.length} / ${capacity || "—"}`} caption="Current work in progress" icon={<Layers3 size={18} />} tone="violet" /><StatCard label="Needs your eye" value={attention.length} caption={attention.length ? "Feedback or approval waiting" : "Nothing waiting on you"} icon={<ShieldCheck size={18} />} tone="peach" onClick={() => onSelectView("requests")} /><StatCard label="In the queue" value={queued.length} caption="Ready for an active lane" icon={<ArrowDownUp size={18} />} tone="mint" onClick={() => onSelectView("requests")} /><StatCard label="Your project manager" value={organization.primary_pm ?? "Not assigned"} caption={organization.primary_pm_email ?? "Your Zellink contact"} icon={<Users size={18} />} tone="blue" />
    </div>
    <div className="section-heading"><div><span className="eyebrow">YOUR WORK</span><h2>Work in motion</h2></div><button className="quiet-link" onClick={() => onSelectView("requests")}>See all requests <ArrowRight size={15} /></button></div>
    <div className="work-grid"><Card className="surface-card work-card"><div className="card-heading-row"><div><span className="eyebrow">ACTIVE</span><h3>Currently in the studio</h3></div><span className="count-pill">{active.length}</span></div>{active.length ? <div className="work-list">{active.slice(0, 4).map((request) => <RequestRow key={request.id} request={request} onClick={() => onOpen(request)} />)}</div> : <CompactEmpty title="A little space to breathe" copy="When work is underway, you’ll see its next step here." />}</Card><Card className="surface-card work-card review-card"><div className="card-heading-row"><div><span className="eyebrow">YOUR TURN</span><h3>Waiting for your feedback</h3></div><span className="count-pill warm">{attention.length}</span></div>{attention.length ? <div className="work-list">{attention.slice(0, 4).map((request) => <RequestRow key={request.id} request={request} onClick={() => onOpen(request)} emphasize />)}</div> : <CompactEmpty title="You’re all caught up" copy="Approvals and feedback will appear here." />}</Card></div>
    <div className="lower-grid"><Card className="surface-card queue-card"><div className="card-heading-row"><div><span className="eyebrow">UP NEXT</span><h3>Queue</h3></div><button className="icon-button" onClick={() => onSelectView("requests")} aria-label="View request queue"><ArrowUpRight size={16} /></button></div>{queued.length ? queued.slice(0, 4).map((request, index) => <div className="queue-row" key={request.id}><span className="queue-number">{String(index + 1).padStart(2, "0")}</span><button className="queue-title" onClick={() => onOpen(request)}>{request.title}<small>{request.serviceType || request.projectName}</small></button><Badge variant="outline">Queued</Badge></div>) : <CompactEmpty title="Nothing waiting in line" copy="New requests go here after your PM reviews the brief." />}</Card><Card className="surface-card pm-card"><div className="pm-orbit"><span>{initials(organization.primary_pm ?? "Zellink")}</span></div><div className="pm-card-content"><span className="eyebrow">YOUR PROJECT MANAGER</span><h3>{organization.primary_pm ?? "Your PM is being assigned"}</h3><p>{organization.primary_pm ? "Your project manager keeps the brief, priorities and next steps connected." : "A Zellink admin will introduce your primary PM soon."}</p>{organization.primary_pm_email && <a href={`mailto:${organization.primary_pm_email}`} className="quiet-link">Contact {organization.primary_pm?.split(" ")[0]} <ArrowUpRight size={14} /></a>}</div></Card></div>
    <div className="section-heading project-section-heading"><div><span className="eyebrow">ORGANIZED TOGETHER</span><h2>Your projects</h2></div><button className="quiet-link" onClick={() => onSelectView("projects")}>Browse projects <ArrowRight size={15} /></button></div><div className="project-grid">{projects.slice(0, 3).map((project, index) => <button className="project-tile" key={project.id} onClick={() => onSelectView("projects")}><span className={`project-art art-${index + 1}`}><FolderKanban size={20} /></span><span><strong>{project.name}</strong><small>{project.request_count ?? 0} requests · {project.state}</small></span><ChevronRight size={17} /></button>)}{projects.length === 0 && <CompactEmpty title="Your first project will live here" copy="Group related requests into a campaign or a shared goal." />}</div>
  </>;
}

function PmView({ organizations, requests, tasks, onboarding, onReviewOnboarding, onUploadOnboardingFile, onDownloadOnboardingFile, onSelect, onOpen, onCreateProject, onCreateRequest, onTransition }: { organizations: Organization[]; requests: Request[]; tasks: Task[]; onboarding: Onboarding | null; onReviewOnboarding: () => void; onUploadOnboardingFile: (file: File) => void; onDownloadOnboardingFile: (fileId: string, name: string) => void; onSelect: (id: string) => void; onOpen: (request: Request) => void; onCreateProject: () => void; onCreateRequest: () => void; onTransition: (request: Request, status: string, reason?: string) => Promise<void> }) {
  const waiting = requests.filter((request) => request.status === "submitted");
  const active = requests.filter((request) => ["in_progress", "internal_review", "client_review"].includes(request.status));
  const paused = organizations.filter((org) => org.subscription_state === "paused");
  return <>
    <PageHeading eyebrow="PROJECT MANAGER STUDIO" title="Keep the work moving." copy="A practical view of the clients, decisions and handoffs on your desk." action={<Button onClick={onCreateRequest}><Plus size={16} /> Prepare a request</Button>} />
    {onboarding && onboarding.status !== "complete" && <div className="notice-banner onboarding-review-banner"><span className="notice-icon"><ClipboardCheck size={17} /></span><div><strong>Onboarding needs your review</strong><p>Check the client context, update the checklist and finish setup when it is ready.</p></div><Button variant="outline" size="sm" onClick={onReviewOnboarding}>Review onboarding <ArrowRight size={13} /></Button></div>}
    <div className="stat-grid"><StatCard label="Requests to review" value={waiting.length} caption="New requests from clients" icon={<Inbox size={18} />} tone="violet" /><StatCard label="Active work" value={active.length} caption="Across your client organizations" icon={<Layers3 size={18} />} tone="mint" /><StatCard label="Waiting on clients" value={requests.filter((request) => request.status === "waiting_on_client").length} caption="Feedback or materials needed" icon={<MessageCircle size={18} />} tone="peach" /><StatCard label="Assigned clients" value={organizations.length} caption="Primary or backup assignment" icon={<BriefcaseBusiness size={18} />} tone="blue" /></div>
    {paused.length > 0 && <div className="notice-banner pause-banner"><span className="notice-icon"><Clock3 size={17} /></span><div><strong>{paused.length} plan{paused.length > 1 ? "s are" : " is"} paused</strong><p>Existing requests can finish and release their lanes. New client work and lane starts are blocked.</p></div></div>}
    {onboarding?.status === "complete" && <OnboardingFiles files={onboarding.files} onUploadFile={onUploadOnboardingFile} onDownloadFile={onDownloadOnboardingFile} />}
    <div className="pm-two-column"><Card className="surface-card review-queue"><div className="card-heading-row"><div><span className="eyebrow">INCOMING</span><h3>Needs your review</h3></div><span className="count-pill">{waiting.length}</span></div>{waiting.length ? waiting.map((request) => <div key={request.id} className="pm-request-row"><RequestRow request={request} onClick={() => onOpen(request)} /><Button size="sm" variant="outline" onClick={() => void onTransition(request, "pm_review")}>Review <ArrowRight size={13} /></Button></div>) : <CompactEmpty title="No new requests" copy="New client submissions will appear here." />}</Card><div className="pm-side-stack"><Card className="surface-card"><div className="card-heading-row"><div><span className="eyebrow">YOUR CLIENTS</span><h3>Client roster</h3></div><Users size={17} /></div>{organizations.slice(0, 5).map((org) => <button className="client-roster-row" key={org.id} onClick={() => onSelect(org.id)}><span className="avatar small-avatar">{initials(org.name)}</span><span><strong>{org.name}</strong><small>{org.industry ?? "Client organization"}</small></span><ChevronRight size={16} /></button>)}{organizations.length === 0 && <CompactEmpty title="No assigned clients yet" copy="An admin can assign a client organization to you." />}</Card><Card className="focus-note"><span className="focus-note-icon"><Sparkles size={19} /></span><span className="eyebrow">A GOOD NEXT STEP</span><h3>Make the brief feel clear.</h3><p>A thoughtful brief gives the client one simple decision before work gets underway.</p><button className="quiet-link" onClick={onCreateProject}>Create a project <ArrowRight size={14} /></button></Card></div></div>
    <div className="section-heading"><div><span className="eyebrow">DELIVERY</span><h2>Active work</h2></div><span className="muted-label">{tasks.length} specialist task{tasks.length === 1 ? "" : "s"}</span></div><Card className="surface-card table-card">{active.length ? <RequestTable requests={active} onOpen={onOpen} /> : <CompactEmpty title="No active work yet" copy="Once a request has a clear brief and an available lane, it will show here." />}</Card>
  </>;
}

function SpecialistView({ tasks, requests, onOpen, onChange }: { tasks: Task[]; requests: Request[]; onOpen: (request: Request) => void; onChange: (task: Task, status: string, reason?: string) => void }) {
  return <><PageHeading eyebrow="SPECIALIST DESK" title="Your work, in one place." copy="The approved brief, production notes and client feedback for your assignments." /><div className="stat-grid specialist-stats"><StatCard label="My assignments" value={tasks.length} caption="Current work from your PMs" icon={<BriefcaseBusiness size={18} />} tone="violet" /><StatCard label="In progress" value={tasks.filter((task) => task.status === "in_progress").length} caption="Tasks you’re moving forward" icon={<Layers3 size={18} />} tone="mint" /><StatCard label="Blocked" value={tasks.filter((task) => task.status === "blocked").length} caption="Share what would unblock you" icon={<Clock3 size={18} />} tone="peach" /></div><div className="section-heading"><div><span className="eyebrow">ASSIGNED TO YOU</span><h2>My assignments</h2></div><span className="muted-label">{tasks.length} tasks</span></div>{tasks.length ? <div className="task-grid">{tasks.map((task) => {
    const request = requests.find((item) => item.id === task.request_id && item.organizationId === task.organization_id);
    return <Card key={task.id} className="surface-card task-card"><div className="task-card-top"><span className="task-icon"><FileText size={17} /></span><Badge className={statusClass(task.status)}>{statusLabel(task.status)}</Badge></div><span className="eyebrow">{task.organization_name} · {task.request_title}</span><h3>{task.title}</h3>{task.internal_scope && <div className="task-context"><strong>Production notes</strong><p>{task.internal_scope}</p></div>}{task.objective && <div className="task-context"><strong>Request objective</strong><p>{task.objective}</p></div>}{task.approved_brief && <details className="task-brief"><summary>Approved brief</summary><p>{task.approved_brief}</p></details>}{task.latest_feedback && <div className="block-reason"><strong>Latest client feedback</strong><span>{task.latest_feedback}</span></div>}{task.block_reason && <div className="block-reason"><strong>Blocked by</strong><span>{task.block_reason}</span></div>}{request && <button className="quiet-link task-context-link" onClick={() => onOpen(request)}>Open request files and discussion <ArrowRight size={14} /></button>}<div className="task-actions">{task.status === "assigned" && <Button size="sm" onClick={() => onChange(task, "in_progress")}>Start task</Button>}{task.status === "in_progress" && <Button size="sm" onClick={() => onChange(task, "submitted")}>Submit for PM review</Button>}<TaskStateMenu task={task} onChange={onChange} /></div></Card>;
  })}</div> : <EmptyState title="Your task list is clear" copy="When a PM assigns work to you, the brief and key context will show here." />}</>;
}

function AdminView({ dashboard, organizations, organization, integrations, onCreate, onSelect, onUpdateEntitlement, onChangeStatus, onAssignPrimaryPm, onAssignBackupPm, onEndBackupPm }: {
  dashboard: Dashboard | null;
  organizations: Organization[];
  organization: Organization | null;
  integrations: Integration[];
  onCreate: () => void;
  onSelect: (id: string) => void;
  onUpdateEntitlement: (organizationId: string, payload: unknown) => void;
  onChangeStatus: (organizationId: string, payload: unknown) => void;
  onAssignPrimaryPm: (organizationId: string, payload: Record<string, unknown>) => void;
  onAssignBackupPm: (organizationId: string, payload: Record<string, unknown>) => void;
  onEndBackupPm: (organizationId: string, payload: Record<string, unknown>) => void;
}) {
  const counts = dashboard?.organizations as { total?: number; active?: number; onboarding?: number; paused?: number } | undefined;
  const [pmUsers, setPmUsers] = useState<{ id: string; display_name: string; disabled_at: string | null }[]>([]);
  const [history, setHistory] = useState<{
    planChanges: { id: string; old_plan_name: string | null; new_plan_name: string | null; old_extra_lanes: number; new_extra_lanes: number; billing_period: string | null; effective_at: string; reason: string; payment_note: string | null; recorded_by_name: string }[];
    pmAssignments: { id: string; assignment_role: string; pm_user_id: string; pm_name: string; reason: string; assigned_at: string; ends_at: string | null }[];
    auditEvents: { action: string; reason: string | null; created_at: string; actor_name: string | null }[];
  } | null>(null);
  const currentBackup = history?.pmAssignments.find((item) => item.assignment_role === "backup" && !item.ends_at);
  useEffect(() => {
    void api<{ users: { id: string; display_name: string; disabled_at: string | null }[] }>("/api/admin/users?role=pm")
      .then((result) => setPmUsers(result.users.filter((user) => !user.disabled_at)))
      .catch(() => setPmUsers([]));
  }, []);
  useEffect(() => {
    if (!organization) { setHistory(null); return; }
    setHistory(null);
    void api<typeof history>(`/api/admin/orgs/${organization.id}/history`)
      .then((result) => setHistory(result))
      .catch(() => setHistory(null));
  }, [organization?.id]);

  return <>
    <PageHeading eyebrow="STUDIO ADMINISTRATION" title="The studio at a glance." copy="Client organizations, operating health and the decisions that need attention." action={<Button onClick={onCreate}><Plus size={16} /> Add a client</Button>} />
    <div className="stat-grid"><StatCard label="Client organizations" value={counts?.total ?? organizations.length} caption="Retained studio relationships" icon={<BriefcaseBusiness size={18} />} tone="violet" /><StatCard label="Active" value={counts?.active ?? 0} caption="Available in the studio" icon={<Check size={18} />} tone="mint" /><StatCard label="Onboarding" value={counts?.onboarding ?? 0} caption="Waiting for setup to finish" icon={<Clock3 size={18} />} tone="peach" /><StatCard label="Paused plans" value={counts?.paused ?? 0} caption="No new work or lane starts" icon={<Layers3 size={18} />} tone="blue" /></div>
    <div className="admin-grid"><Card className="surface-card admin-organizations"><div className="card-heading-row"><div><span className="eyebrow">CLIENT DIRECTORY</span><h3>Client organizations</h3></div><Button variant="outline" size="sm" onClick={onCreate}>Add organization <Plus size={14} /></Button></div>{organizations.length ? <div className="directory-list">{organizations.map((org) => <button key={org.id} className={`directory-row ${organization?.id === org.id ? "selected-organization-row" : ""}`} aria-pressed={organization?.id === org.id} onClick={() => onSelect(org.id)}><span className="avatar small-avatar">{initials(org.name)}</span><span className="directory-main"><strong>{org.name}</strong><small>{org.primary_pm ? `PM · ${org.primary_pm}` : "No PM assigned"}</small></span><span className="directory-meta"><span className={`status-dot ${org.subscription_state === "active" ? "ready" : org.subscription_state === "paused" ? "paused" : "pending"}`} />{org.subscription_state ?? org.status}</span><ChevronRight size={16} /></button>)}</div> : <CompactEmpty title="No organizations yet" copy="Add a client and assign their primary PM to get started." />}</Card><div className="admin-side-stack"><Card className="surface-card"><div className="card-heading-row"><div><span className="eyebrow">INTEGRATIONS</span><h3>Connection status</h3></div><ShieldCheck size={17} /></div>{integrations.map((integration) => <div key={integration.provider_key} className="integration-row"><span><strong>{capitalize(integration.provider_key)}</strong><small>{integration.status_detail || (integration.configured ? "Configured" : "Not configured")}</small></span><Badge variant="outline" className={integration.configured ? "badge-ready" : "badge-muted"}>{integration.configured ? "Connected" : "Off"}</Badge></div>)}</Card><Card className="focus-note admin-retention"><span className="focus-note-icon"><ShieldCheck size={19} /></span><span className="eyebrow">RECORDS</span><h3>History stays with the work.</h3><p>Closed client records remain permanently stored. Export and deletion controls are not part of this release.</p></Card></div></div>
    {organization && <section className="admin-detail-section"><div className="section-heading"><div><span className="eyebrow">CLIENT CONTROLS</span><h2>{organization.name}</h2></div><span className="muted-label">{organization.active_lanes ?? 0} active lanes · {organization.queued_requests ?? 0} queued</span></div><div className="admin-control-grid">
      <Card className="surface-card admin-control-card"><span className="eyebrow">PLAN & LANES</span><h3>Manual plan record</h3><p>These are studio records only. No payment is collected or verified here.</p><form className="form-grid" key={`${organization.id}:${organization.plan_id}:${organization.extra_lanes}:${organization.subscription_state}:${organization.billing_period}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onUpdateEntitlement(organization.id, { planId: form.get("planId"), extraLanes: Number(form.get("extraLanes")), billingPeriod: form.get("billingPeriod") || null, subscriptionState: form.get("subscriptionState"), reason: form.get("reason"), paymentNote: form.get("paymentNote") }); }}><FormField label="Plan"><select name="planId" defaultValue={organization.plan_id ?? "foundation"}><option value="foundation">Foundation · 1 included lane</option><option value="growth">Growth · 2 included lanes</option><option value="scale">Scale · 3 included lanes</option></select></FormField><div className="field-row"><FormField label="Extra lanes"><Input name="extraLanes" type="number" min="0" step="1" defaultValue={organization.extra_lanes ?? 0} required /></FormField><FormField label="Billing period"><select name="billingPeriod" defaultValue={organization.billing_period ?? ""}><option value="">Not recorded</option><option value="monthly">Monthly</option><option value="annual">Annual</option></select></FormField></div><FormField label="Plan state"><select name="subscriptionState" defaultValue={organization.subscription_state ?? "pending"}><option value="pending">Pending</option><option value="active">Active</option><option value="paused">Paused</option><option value="ended">Ended</option></select></FormField><FormField label="Reason for this change"><Input name="reason" required minLength={3} maxLength={500} placeholder="Why is the plan record changing?" /></FormField><FormField label="Manual payment note"><Textarea name="paymentNote" maxLength={1000} placeholder="Optional internal note. No provider status is implied." /></FormField><Button type="submit">Save plan record</Button></form></Card>
      <Card className="surface-card admin-control-card"><span className="eyebrow">OWNERSHIP & ACCESS</span><h3>Primary project manager</h3><p>Assignment changes are recorded in organization history.</p><form className="form-grid" key={`${organization.id}:${organization.primary_pm_user_id ?? "none"}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onAssignPrimaryPm(organization.id, { pmUserId: form.get("pmUserId"), reason: form.get("reason") }); }}><FormField label="Assign a PM"><select name="pmUserId" defaultValue={organization.primary_pm_user_id ?? ""} required><option value="" disabled>Choose a project manager</option>{pmUsers.map((user) => <option value={user.id} key={user.id}>{user.display_name}</option>)}</select></FormField><FormField label="Reason for assignment"><Input name="reason" required minLength={3} maxLength={500} placeholder="Primary coverage or handoff reason" /></FormField><Button type="submit" disabled={pmUsers.length === 0}>Assign primary PM</Button></form><hr /><h3>Temporary backup project manager</h3><p>{currentBackup ? `${currentBackup.pm_name} is currently assigned as backup.` : "No temporary backup is assigned."}</p><form className="form-grid" key={`${organization.id}:${currentBackup?.pm_user_id ?? "none"}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const reason = String(form.get("reason") ?? ""); if (form.get("action") === "end") onEndBackupPm(organization.id, { reason }); else onAssignBackupPm(organization.id, { pmUserId: String(form.get("pmUserId") ?? ""), reason }); }}><FormField label="Backup PM"><select name="pmUserId" defaultValue={currentBackup?.pm_user_id ?? ""} required><option value="" disabled>Choose a project manager</option>{pmUsers.map((user) => <option value={user.id} key={user.id}>{user.display_name}</option>)}</select></FormField><FormField label="Reason for coverage"><Input name="reason" required minLength={3} maxLength={500} placeholder="Temporary cover while the primary PM is away" /></FormField><div className="button-row"><Button type="submit" name="action" value="assign" variant="outline" disabled={pmUsers.length === 0}>Assign backup</Button>{currentBackup && <Button type="submit" name="action" value="end" variant="outline" formNoValidate>End backup assignment</Button>}</div></form><hr /><h3>Organization access</h3><p>Closed records remain stored permanently. They can be restored by changing the status.</p><form className="form-grid" key={`${organization.id}:${organization.status}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onChangeStatus(organization.id, { status: form.get("status"), reason: form.get("reason") }); }}><FormField label="Organization status"><select name="status" defaultValue={organization.status}><option value="onboarding">Onboarding</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option></select></FormField><FormField label="Reason for status change"><Input name="reason" required minLength={3} maxLength={500} placeholder="Why is access changing?" /></FormField><Button type="submit" variant="outline">Update organization status</Button></form></Card>
      <Card className="surface-card admin-control-card admin-history-card"><span className="eyebrow">HISTORY</span><h3>Plan changes</h3>{history?.planChanges.length ? <div className="admin-history-list">{history.planChanges.slice(0, 8).map((item) => <div className="admin-history-row" key={item.id}><strong>{item.new_plan_name ?? "Unassigned"} · {item.new_extra_lanes} extra lanes</strong><small>{item.reason} · {item.recorded_by_name} · {formatDate(item.effective_at)}</small>{item.payment_note && <p>Manual note: {item.payment_note}</p>}</div>)}</div> : <CompactEmpty title={history ? "No plan history yet" : "Loading plan history"} copy={history ? "Recorded plan changes will appear here." : ""} />}<h3 className="history-subheading">PM assignment history</h3>{history?.pmAssignments.length ? <div className="admin-history-list">{history.pmAssignments.slice(0, 8).map((item) => <div className="admin-history-row" key={item.id}><strong>{item.pm_name} · {item.assignment_role}{item.ends_at ? " · ended" : " · current"}</strong><small>{item.reason} · {formatDate(item.assigned_at)}</small></div>)}</div> : <CompactEmpty title={history ? "No assignments yet" : "Loading assignment history"} copy="" />}<h3 className="history-subheading">Recent administrative changes</h3>{history?.auditEvents.slice(0, 8).map((item, index) => <div className="admin-history-row" key={`${item.action}-${item.created_at}-${index}`}><strong>{item.action.replaceAll("_", " ")}</strong><small>{item.reason || "Change recorded"} · {item.actor_name || "System"} · {formatDate(item.created_at)}</small></div>)}{history && history.auditEvents.length === 0 && <CompactEmpty title="No administrative changes yet" copy="Status, access and plan updates will appear here." />}</Card>
    </div></section>}
    <div className="section-heading"><div><span className="eyebrow">WORKFLOW</span><h2>Request status overview</h2></div></div><Card className="surface-card status-summary">{(dashboard?.requestStatuses ?? []).length ? (dashboard?.requestStatuses ?? []).map((item) => <div key={item.status} className="status-summary-row"><span>{statusLabel(item.status)}</span><div className="status-track"><i style={{ width: `${Math.min(100, Number(item.count) * 12)}%` }} /></div><strong>{item.count}</strong></div>) : <CompactEmpty title="No request activity" copy="Request volume and status changes will be visible here." />}</Card>
  </>;
}

function RequestsView({ actor, organization, requests, projects, onCreate, onOpen, onTransition, onReorder }: { actor: Actor; organization: Organization | null; requests: Request[]; projects: Project[]; onCreate: () => void; onOpen: (request: Request) => void; onTransition: (request: Request, status: string, reason?: string) => Promise<void>; onReorder: (requestId: string, targetIndex: number, organizationId: string) => void }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? requests : requests.filter((request) => request.status === filter);
  const canCreate = actor.globalRole === "pm" || actor.globalRole === "admin" || actor.globalRole === "super_admin" ||
    (actor.globalRole === "client" && organization?.can_submit === 1);
  const canReorder = actor.globalRole === "pm" || actor.globalRole === "admin" || actor.globalRole === "super_admin" ||
    (actor.globalRole === "client" && organization?.can_submit === 1);
  const paused = organization?.subscription_state === "paused" || organization?.status === "paused";
  const clientNeedsOnboarding = actor.globalRole === "client" && organization?.onboarding_status !== "complete";
  const createDisabled = paused || clientNeedsOnboarding;
  return <>
    <PageHeading eyebrow={actor.globalRole === "pm" ? "PM WORKSPACE" : "CLIENT WORKSPACE"} title={actor.globalRole === "pm" ? "Studio queue" : "Requests"} copy={organization ? `A shared record of the work with ${organization.name}.` : "A shared record of the work and what comes next."} action={canCreate && <Button onClick={onCreate} disabled={createDisabled}><Plus size={16} /> New request</Button>} />
    {clientNeedsOnboarding && <div className="notice-banner"><span className="notice-icon"><ClipboardCheck size={17} /></span><div><strong>Finish onboarding first</strong><p>Your project manager will help complete setup before you add new requests.</p></div></div>}
    {paused && <div className="notice-banner pause-banner"><span className="notice-icon"><Clock3 size={17} /></span><div><strong>Your plan is paused</strong><p>You can update existing requests and follow current work. New requests and lane starts are paused.</p></div></div>}
    <div className="filter-bar"><div className="filter-tabs" role="group" aria-label="Filter requests">{[{ id: "all", label: "All work" }, { id: "submitted", label: "Needs review" }, { id: "in_progress", label: "In progress" }, { id: "queued", label: "Queued" }, { id: "client_review", label: "Client review" }].map((item) => <button key={item.id} className={filter === item.id ? "selected" : ""} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><span className="muted-label">{filtered.length} request{filtered.length === 1 ? "" : "s"}</span></div>
    {filtered.length ? <Card className="surface-card table-card"><RequestTable requests={filtered} onOpen={onOpen} onTransition={onTransition} onReorder={canReorder ? onReorder : undefined} role={actor.globalRole} projects={projects} /></Card> : <EmptyState title={filter === "all" ? "No requests yet" : `No ${statusLabel(filter).toLowerCase()} requests`} copy={filter === "all" ? "Create a first request to start a clear conversation with your project manager." : "Requests will appear here as their status changes."} action={canCreate && filter === "all" ? <Button onClick={onCreate} disabled={createDisabled}><Plus size={15} /> New request</Button> : undefined} />}
  </>;
}

function ProjectsView({ projects, requests, actor, onCreate, onOpen }: { projects: Project[]; requests: Request[]; actor: Actor; onCreate: () => void; onOpen: (request: Request) => void }) {
  const canCreate = actor.globalRole !== "specialist";
  return <><PageHeading eyebrow="PROJECTS & CAMPAIGNS" title="Work with a shared shape." copy="Group related requests around a campaign, launch or ongoing goal." action={canCreate && <Button onClick={onCreate}><Plus size={16} /> Create project</Button>} />{projects.length ? <div className="projects-page-grid">{projects.map((project, index) => { const projectRequests = requests.filter((request) => request.projectId === project.id); return <Card key={project.id} className="surface-card project-card"><div className={`project-banner art-${index % 3 + 1}`}><span><FolderKanban size={20} /></span><Badge variant="outline">{project.state}</Badge></div><div className="project-card-copy"><span className="eyebrow">{projectRequests.length} REQUEST{projectRequests.length === 1 ? "" : "S"}</span><h3>{project.name}</h3><p>{project.summary || "This project keeps related work and decisions together."}</p>{projectRequests.slice(0, 3).map((request) => <button className="project-request-row" key={request.id} onClick={() => onOpen(request)}><span className="status-dot" /><span>{request.title}</span><Badge className={statusClass(request.status)}>{statusLabel(request.status)}</Badge></button>)}</div></Card>; })}</div> : <EmptyState title="Your first project starts here" copy="Projects give related requests a shared place to live." action={canCreate ? <Button onClick={onCreate}><Plus size={15} /> Create project</Button> : undefined} />}</>;
}

function TeamView({ actor, organization, members, staff, onAddMember, onCreateStaff, onToggleStaff, onResetPassword }: { actor: Actor; organization: Organization | null; members: TeamMember[]; staff: StaffMember[]; onAddMember: () => void; onCreateStaff: () => void; onToggleStaff: (member: StaffMember) => void; onResetPassword: (member: PasswordResetTarget) => void }) {
  if (actor.globalRole === "admin" || actor.globalRole === "super_admin") return <><PageHeading eyebrow="STUDIO TEAM" title="People behind the work." copy="Create staff accounts and keep access in the right hands." action={<Button onClick={onCreateStaff}><Plus size={16} /> Add a team member</Button>} /><div className="notice-banner"><span className="notice-icon"><ShieldCheck size={17} /></span><div><strong>Manual account provisioning</strong><p>New team members receive a one-time password that must be changed at first sign-in. Share it through an agreed channel.</p></div></div><Card className="surface-card team-directory">{staff.length ? staff.map((member) => { const privileged = member.global_role === "admin" || member.global_role === "super_admin"; const canManage = member.id !== actor.id && (!privileged || actor.globalRole === "super_admin"); return <div className="directory-row" key={member.id}><span className="avatar small-avatar">{initials(member.display_name)}</span><span className="directory-main"><strong>{member.display_name}</strong><small>{member.email}{member.disabled_at ? " · Access suspended" : " · Access active"}</small></span><Badge variant="outline" className={member.disabled_at ? "badge-muted" : "badge-violet"}>{roleLabel(member.global_role as GlobalRole)}</Badge><Button size="sm" variant="outline" disabled={!canManage} onClick={() => onResetPassword(member)}>Reset password</Button><Button size="sm" variant="outline" disabled={!canManage} onClick={() => onToggleStaff(member)}>{member.disabled_at ? "Restore access" : "Suspend access"}</Button></div>; }) : <CompactEmpty title="Staff directory is ready" copy="Create the first team account when you are ready." />}</Card><section className="client-member-admin"><div className="card-heading-row"><div><span className="eyebrow">CLIENT ACCESS</span><h3>{organization ? `Members at ${organization.name}` : "Select a client organization"}</h3></div>{organization && <Button onClick={onAddMember}><Plus size={15} /> Add a client member</Button>}</div><Card className="surface-card team-directory">{organization ? members.map((member) => <div className="directory-row" key={member.id}><span className="avatar small-avatar">{initials(member.display_name)}</span><span className="directory-main"><strong>{member.display_name}</strong><small>{member.email} · {member.can_approve ? "Can approve" : member.can_submit ? "Can submit requests" : "View access"}</small></span><Badge variant="outline">{member.client_role === "owner" ? "Owner" : "Member"}</Badge><Button size="sm" variant="outline" disabled={member.id === actor.id} onClick={() => onResetPassword(member)}>Reset password</Button></div>) : <CompactEmpty title="Choose a client" copy="Select a client organization to review its members and provision another account." />}{organization && members.length === 0 && <CompactEmpty title="No client members found" copy="Add the first member to this organization." />}</Card></section></>;
  const canManageMembers = organization?.client_role === "owner" && organization.can_manage_members === 1;
  return <><PageHeading eyebrow="CLIENT TEAM" title="Your team, working together." copy="Your owner can add colleagues and choose what they can do." action={canManageMembers && <Button onClick={onAddMember}><Plus size={16} /> Add a member</Button>} /><div className="notice-banner"><span className="notice-icon"><Users size={17} /></span><div><strong>Unlimited client members</strong><p>There is no product cap on people in your organization. The owner controls member access.</p></div></div><Card className="surface-card team-access">{members.map((member) => <div className="team-person" key={member.id}><span className="avatar">{initials(member.display_name)}</span><span><strong>{member.display_name}</strong><small>{member.email} · {member.can_approve ? "Can approve" : member.can_submit ? "Can submit requests" : "View access"}</small></span><Badge variant="outline">{member.client_role === "owner" ? "Owner" : "Member"}</Badge></div>)}{members.length === 0 && <CompactEmpty title="No team members found" copy="Ask the organization owner to add members." />}</Card></>;
}

function InboxView({ notifications, onRead, onReadAll }: { notifications: Notification[]; onRead: (notification: Notification) => void; onReadAll: () => void }) {
  return <><PageHeading eyebrow="IN-APP NOTIFICATIONS" title="A place for the important bits." copy="Requests, approvals and updates linked to the work they belong to." action={notifications.some((item) => !item.read_at) && <Button variant="outline" onClick={onReadAll}>Mark all read</Button>} />{notifications.length ? <Card className="surface-card inbox-list">{notifications.map((item) => <button className={`notification-row ${item.read_at ? "read" : "unread"}`} key={item.id} onClick={() => !item.read_at && onRead(item)}><span className="notification-marker"><Bell size={15} /></span><span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><small>{formatDate(item.created_at)}</small></span>{!item.read_at && <span className="unread-dot" />}</button>)}</Card> : <EmptyState title="Nothing new to catch up on" copy="In-app updates will appear here, with a link back to the related request." />}</>;
}

function OnboardingCard({ onboarding, onSave }: { onboarding: Onboarding; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const done = Object.values(onboarding.checklist).filter(Boolean).length;
  const total = Object.keys(onboarding.checklist).length;
  return <section className="onboarding-panel"><div className="onboarding-banner"><div className="onboarding-icon"><Sparkles size={19} /></div><div className="onboarding-copy"><span className="eyebrow">A GOOD START</span><strong>Your onboarding is {onboarding.status.replaceAll("_", " ")}.</strong><span>Your PM is reviewing your company details and getting the first brief ready.</span></div><div className="onboarding-progress"><strong>{total ? `${done}/${total}` : "In progress"}</strong><small>checklist items</small><div className="progress-track"><i style={{ width: `${total ? done / total * 100 : 25}%` }} /></div></div></div><form className="onboarding-form" onSubmit={onSave}><div className="onboarding-form-heading"><div><span className="eyebrow">COMPANY CONTEXT</span><h3>A few things to help your PM get started.</h3></div><span className="muted-label">You can update these later.</span></div><div className="field-row"><FormField label="Company name"><Input name="companyName" defaultValue={answerValue(onboarding.answers.companyName)} placeholder="Your company" /></FormField><FormField label="Main contact"><Input name="mainContact" defaultValue={answerValue(onboarding.answers.mainContact)} placeholder="Name and role" /></FormField></div><FormField label="Website and relevant links"><Input name="website" defaultValue={answerValue(onboarding.answers.website)} placeholder="https:// and any helpful links" /></FormField><div className="field-row"><FormField label="Business goals"><Textarea name="businessGoals" defaultValue={answerValue(onboarding.answers.businessGoals)} placeholder="What are you working toward?" /></FormField><FormField label="Current priorities"><Textarea name="priorities" defaultValue={answerValue(onboarding.answers.priorities)} placeholder="What matters most right now?" /></FormField></div><div className="field-row"><FormField label="Brand assets and guidelines"><Textarea name="brandAssets" defaultValue={answerValue(onboarding.answers.brandAssets)} placeholder="Describe available material or add links. Never paste passwords or access tokens." /></FormField><FormField label="Communication preferences"><Textarea name="communicationPreferences" defaultValue={answerValue(onboarding.answers.communicationPreferences)} placeholder="How should your team work together?" /></FormField></div><FormField label="Existing tools and workspaces"><Input name="existingTools" defaultValue={answerValue(onboarding.answers.existingTools)} placeholder="Tool names and non-sensitive workspace links" /></FormField><div className="onboarding-actions"><span><ShieldCheck size={14} /> Don’t enter passwords or private credentials in these fields.</span><div><Button type="submit" name="submit" value="false" variant="outline">Save for later</Button><Button type="submit" name="submit" value="true">Send to my PM <ArrowRight size={14} /></Button></div></div></form></section>;
}

const ONBOARDING_CHECKLIST = [
  ["company_contact", "Company and main contact details are clear"],
  ["website_links", "Website and useful links have been reviewed"],
  ["business_goals", "Business goals and current priorities are understood"],
  ["brand_assets", "Brand assets, guidelines and references are ready"],
  ["communication_preferences", "Communication preferences are recorded"],
  ["existing_tools", "Existing tools and workspaces are noted"],
] as const;

function OnboardingReviewForm({ onboarding, onSave, onComplete, onUploadFile, onDownloadFile }: { onboarding: Onboarding; onSave: (checklist: Record<string, boolean>) => Promise<void>; onComplete: () => Promise<void>; onUploadFile: (file: File) => void; onDownloadFile: (fileId: string, name: string) => void }) {
  const initialChecklist = Object.fromEntries(ONBOARDING_CHECKLIST.map(([key]) => [key, onboarding.checklist[key] ?? false]));
  const [checklist, setChecklist] = useState<Record<string, boolean>>(initialChecklist);
  useEffect(() => { setChecklist(Object.fromEntries(ONBOARDING_CHECKLIST.map(([key]) => [key, onboarding.checklist[key] ?? false]))); }, [onboarding.id, JSON.stringify(onboarding.checklist)]);
  const matchesSaved = ONBOARDING_CHECKLIST.every(([key]) => checklist[key] === onboarding.checklist[key]);
  const allComplete = ONBOARDING_CHECKLIST.every(([key]) => checklist[key]);
  const answerLabels: Record<string, string> = {
    companyName: "Company name", mainContact: "Main contact", website: "Website and links",
    businessGoals: "Business goals", priorities: "Current priorities", brandAssets: "Brand assets and guidelines",
    communicationPreferences: "Communication preferences", existingTools: "Existing tools and workspaces",
  };
  const answers = Object.entries(onboarding.answers).map(([key, value]) => ({ key, label: answerLabels[key] ?? key, value: answerValue(value) })).filter((answer) => answer.value.trim());
  return <div className="onboarding-review-form">
    <div className="review-client-context"><span className="eyebrow">CLIENT CONTEXT</span><p>Review the client’s information with them, fill gaps together, then confirm each checklist item.</p></div>
    <section className="review-answers" aria-label="Client onboarding answers">
      {answers.length ? answers.map((answer) => <div className="review-answer" key={answer.key}><strong>{answer.label}</strong><p>{answer.value}</p></div>) : <CompactEmpty title="No answers added yet" copy="Ask the client to save their company details before completing onboarding." />}
    </section>
    <OnboardingFiles files={onboarding.files} onUploadFile={onUploadFile} onDownloadFile={onDownloadFile} />
    <div className="review-checklist"><span className="eyebrow">ONBOARDING CHECKLIST</span>{ONBOARDING_CHECKLIST.map(([key, label]) => <label className="check-field review-check" key={key}><input type="checkbox" checked={Boolean(checklist[key])} onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div>
    <div className="review-actions"><Button variant="outline" onClick={() => void onSave(checklist)}>Save checklist</Button><Button onClick={() => void onComplete()} disabled={!allComplete || !matchesSaved || onboarding.status !== "pm_review"}>Complete onboarding <Check size={14} /></Button></div>
    <p className="form-footnote"><ShieldCheck size={14} />Complete only after you have reviewed the information with the client.</p>
  </div>;
}

function OnboardingFiles({ files = [], onUploadFile, onDownloadFile }: { files?: OnboardingFile[]; onUploadFile: (file: File) => void; onDownloadFile: (fileId: string, name: string) => void }) {
  const upload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const selected = new FormData(form).get("file");
    if (selected instanceof File) { onUploadFile(selected); form.reset(); }
  };
  return <section className="onboarding-files" aria-labelledby="onboarding-files-title"><div className="detail-section-heading"><div><span className="eyebrow">BRAND & REFERENCE FILES</span><h3 id="onboarding-files-title">Onboarding files</h3></div><span className="muted-label">{files.length} items</span></div>{files.length ? <div className="file-list">{files.map((file) => <div className="file-row" key={file.id}><span className="file-icon"><Paperclip size={15} /></span><span className="file-copy"><strong>{file.original_name}</strong><small>{formatBytes(file.byte_size)} · Added by {file.uploader_name} · {formatDate(file.created_at)}</small></span><Badge className={statusClass(file.scan_state)}>{file.scan_state.replaceAll("_", " ")}</Badge>{file.scan_state === "clean" && <button type="button" className="icon-button" onClick={() => onDownloadFile(file.id, file.original_name)} aria-label={`Download ${file.original_name}`}><ArrowDownUp size={15} /></button>}</div>)}</div> : <CompactEmpty title="No onboarding files yet" copy="Upload brand guidelines, references or other non-sensitive project material." />}<form className="file-upload-form" onSubmit={upload}><label className="upload-label"><Paperclip size={15} /><span>Add an onboarding file</span><input type="file" name="file" required accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,application/zip,.docx,.pptx" /></label><Button size="sm" type="submit" variant="outline">Upload</Button><small>Files stay private while they’re scanned. Never upload passwords or access tokens.</small></form></section>;
}

function RequestTable({ requests, onOpen, onTransition, onReorder, role, projects }: { requests: Request[]; onOpen: (request: Request) => void; onTransition?: (request: Request, status: string, reason?: string) => Promise<void>; onReorder?: (requestId: string, targetIndex: number, organizationId: string) => void; role?: GlobalRole; projects?: Project[] }) {
  const queued = requests.filter((request) => request.status === "queued").sort((left, right) => left.queuePosition - right.queuePosition);
  const queueIndex = new Map(queued.map((request, index) => [request.id, index]));
  return <div className="table-scroll"><table className="request-table"><thead><tr><th>Request</th><th>Project</th><th>Priority</th><th>Status</th><th>Lane</th><th>Updated</th><th><span className="sr-only">Actions and queue order</span></th></tr></thead><tbody>{requests.map((request) => {
    const position = queueIndex.get(request.id);
    const canMove = position !== undefined && onReorder !== undefined;
    const drop = (event: React.DragEvent<HTMLTableRowElement>) => {
      event.preventDefault();
      const movedId = event.dataTransfer.getData("text/plain");
      const moved = queued.find((item) => item.id === movedId);
      if (moved && position !== undefined && moved.id !== request.id) onReorder?.(moved.id, position, request.organizationId);
    };
    return <tr key={request.id} className={canMove ? "queue-draggable-row" : undefined} draggable={canMove}
      onDragStart={canMove ? (event) => event.dataTransfer.setData("text/plain", request.id) : undefined}
      onDragOver={canMove ? (event) => event.preventDefault() : undefined} onDrop={canMove ? drop : undefined}>
      <td><button className="table-title" onClick={() => onOpen(request)}>{request.title}<small>{request.serviceType || "Creative request"}</small></button></td><td>{request.projectName}</td><td><PriorityPill priority={request.priority} /></td><td><Badge className={statusClass(request.status)}>{statusLabel(request.status)}</Badge></td><td>{request.laneNumber ? <span className="lane-label">Lane {request.laneNumber}</span> : <span className="muted-label">—</span>}</td><td>{formatDate(request.updatedAt)}</td><td className="table-action"><button className="icon-button" onClick={() => onOpen(request)} aria-label={`Open ${request.title}`}><ArrowUpRight size={15} /></button>{canMove && <div className="queue-move-controls"><button className="icon-button queue-move-button" onClick={() => onReorder?.(request.id, position - 1, request.organizationId)} disabled={position === 0} aria-label={`Move ${request.title} up in the queue`} title="Move up"><ChevronUp size={14} /></button><button className="icon-button queue-move-button" onClick={() => onReorder?.(request.id, position + 1, request.organizationId)} disabled={position === queued.length - 1} aria-label={`Move ${request.title} down in the queue`} title="Move down"><ChevronDown size={14} /></button></div>}{role === "pm" && request.status === "brief_ready" && onTransition && <Button size="sm" variant="outline" onClick={() => void onTransition(request, "queued")}>Queue</Button>}</td>
    </tr>;
  })}</tbody></table>{projects && projects.length === 0 && <span className="table-footnote">Create a project first to group requests.</span>}</div>;
}

function RequestRow({ request, onClick, emphasize }: { request: Request; onClick: () => void; emphasize?: boolean }) {
  return <button className={`request-row ${emphasize ? "request-row-emphasize" : ""}`} onClick={onClick}><span className={`request-type-icon ${emphasize ? "warm" : ""}`}>{emphasize ? <MessageCircle size={15} /> : <FileText size={15} />}</span><span className="request-row-copy"><strong>{request.title}</strong><small>{request.projectName} <span>·</span> {request.serviceType || statusLabel(request.status)}</small></span><Badge className={statusClass(request.status)}>{statusLabel(request.status)}</Badge><ArrowUpRight className="request-arrow" size={15} /></button>;
}

function RequestDetail({ request, data, role, saving, onClose, onRefresh, onAction, setToast }: { request: Request; data: DetailData; role: GlobalRole; saving: boolean; onClose: () => void; onRefresh: () => Promise<void>; onAction: (action: () => Promise<void>, success?: string) => void; setToast: (message: string) => void }) {
  const [comment, setComment] = useState("");
  const [commentVisibility, setCommentVisibility] = useState<"client" | "internal">("client");
  const [briefText, setBriefText] = useState("");
  const clientRole = role === "client";
  const canManageFiles = role === "pm" || role === "admin" || role === "super_admin";
  const pendingApproval = data.approvals.find((approval) => approval.state === "pending");
  const canWrite = true;
  const postComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!comment.trim()) return;
    const visibility = clientRole ? "client" : role === "specialist" ? "internal" : commentVisibility;
    onAction(async () => { await api(`/api/orgs/${request.organizationId}/requests/${request.id}/comments`, json("POST", { body: comment, visibility })); setComment(""); await onRefresh(); }, visibility === "internal" ? "Internal note added" : "Comment added");
  };
  const submitBrief = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); onAction(async () => { await api(`/api/orgs/${request.organizationId}/requests/${request.id}/briefs`, json("POST", { content: briefText })); setBriefText(""); await onRefresh(); }, "Brief sent for client approval");
  };
  const decision = (approval: Approval, value: "approved" | "revision_requested") => onAction(async () => {
    await api(`/api/orgs/${request.organizationId}/requests/${request.id}/approvals/${approval.id}/decision`, json("POST", { decision: value, expectedRequestVersion: approval.version }));
    await onRefresh(); setToast(value === "approved" ? "Approved" : "Revision requested");
  }, value === "approved" ? "Approved" : "Revision requested");
  const upload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const body = new FormData(form);
    onAction(async () => { await api(`/api/orgs/${request.organizationId}/requests/${request.id}/files`, { method: "POST", body }); form.reset(); await onRefresh(); }, "File uploaded for security scanning");
  };
  const taskUpdate = (path: string, payload: unknown, success: string) => onAction(async () => { await api(path, json("POST", payload)); await onRefresh(); }, success);
  const download = (fileId: string, name: string) => void onAction(async () => {
    const response = await fetch(`/api/orgs/${request.organizationId}/files/${fileId}/download`, { credentials: "same-origin" });
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new ApiError(response.status, body.error ?? "download_failed"); }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "Download started");
  return <AccessibleDialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogPortal><DialogOverlay className="request-detail-overlay" /><DialogContent className="request-detail-panel" showCloseButton={false} aria-labelledby="request-detail-title"><header className="detail-header"><div><span className="eyebrow">{request.projectName} · {request.serviceType || "REQUEST"}</span><DialogTitle id="request-detail-title">{request.title}</DialogTitle></div><button className="icon-button" onClick={onClose} aria-label="Close request details"><X size={18} /></button></header><div className="detail-scroll"><div className="detail-meta-row"><Badge className={statusClass(request.status)}>{statusLabel(request.status)}</Badge><PriorityPill priority={request.priority} />{request.laneNumber && <span className="lane-label">Lane {request.laneNumber}</span>}<span className="muted-label">Updated {formatDate(request.updatedAt)}</span></div>{request.summary && <p className="detail-summary">{request.summary}</p>}{request.objective && <div className="detail-section"><span className="eyebrow">OBJECTIVE</span><p>{request.objective}</p></div>}{request.references.length > 0 && <div className="detail-section"><span className="eyebrow">REFERENCE LINKS</span>{request.references.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}<ArrowUpRight size={13} /></a>)}</div>}
    {pendingApproval && <div className={`approval-card ${pendingApproval.approval_kind === "first_brief" ? "approval-brief" : "approval-deliverable"}`}><div><span className="eyebrow">{pendingApproval.approval_kind === "first_brief" ? "FIRST BRIEF" : "DELIVERABLE REVIEW"}</span><strong>{pendingApproval.approval_kind === "first_brief" ? "Does this brief feel right?" : "Review the finished work."}</strong><p>{pendingApproval.approval_kind === "first_brief" ? "A quick approval gives your PM a clear direction to start." : "Approve this version or leave a note about what should change."}</p></div>{clientRole && <div className="approval-actions"><Button onClick={() => decision(pendingApproval, "approved")} disabled={saving}><Check size={14} /> Approve</Button><Button variant="outline" onClick={() => decision(pendingApproval, "revision_requested")} disabled={saving}>Request a revision</Button></div>}</div>}
    {data.briefs.length > 0 && <div className="detail-section"><div className="detail-section-heading"><div><span className="eyebrow">BRIEF HISTORY</span><h3>Shared direction</h3></div></div>{data.briefs.map((brief) => <div className="brief-card" key={brief.id}><div className="brief-top"><strong>Version {brief.version_number}{brief.is_first_brief ? " · First brief" : ""}</strong><Badge variant="outline" className={brief.approval_state === "approved" ? "badge-ready" : "badge-muted"}>{brief.approval_state ?? "Shared"}</Badge></div><p>{brief.content}</p><small>{brief.created_by_name}</small></div>)}</div>}
    {role === "pm" || role === "admin" || role === "super_admin" ? <div className="detail-section"><span className="eyebrow">PM ACTIONS</span><div className="pm-detail-actions">{["draft", "submitted"].includes(request.status) && <Button size="sm" onClick={() => taskUpdate(`/api/orgs/${request.organizationId}/requests/${request.id}/transition`, { toStatus: "pm_review", expectedVersion: request.version }, "Request moved into PM review")}>Start PM review</Button>}{(request.status === "pm_review" || request.status === "revision_requested") && <form className="brief-compose" onSubmit={submitBrief}><label htmlFor="brief-content">Prepare the brief</label><Textarea id="brief-content" value={briefText} onChange={(event) => setBriefText(event.target.value)} required minLength={20} maxLength={30000} placeholder="Capture the goal, audience, deliverables, references and open questions." /><Button size="sm" type="submit" disabled={saving || briefText.trim().length < 20}>Send for approval <ArrowRight size={14} /></Button></form>}{request.status === "brief_ready" && data.approvals.some((approval) => approval.approval_kind === "first_brief" && approval.state === "approved") && <Button size="sm" onClick={() => taskUpdate(`/api/orgs/${request.organizationId}/requests/${request.id}/transition`, { toStatus: "queued", expectedVersion: request.version }, "Request added to the queue")}>Add to queue</Button>}{request.status === "queued" && <Button size="sm" onClick={() => onAction(async () => { await api(`/api/orgs/${request.organizationId}/requests/${request.id}/allocate`, json("POST", { expectedVersion: request.version })); await onRefresh(); }, "Lane allocated")}>Start in an active lane</Button>}{request.status === "internal_review" && <Button size="sm" onClick={() => taskUpdate(`/api/orgs/${request.organizationId}/requests/${request.id}/submit-deliverable`, {}, "Deliverable submitted for client review")}>Share with client</Button>}{["in_progress", "internal_review", "queued"].includes(request.status) && <TaskComposer request={request} staff={[]} onCreated={onRefresh} onAction={onAction} />}</div></div> : null}
    <div className="detail-section"><div className="detail-section-heading"><div><span className="eyebrow">FILES</span><h3>Shared files</h3></div><span className="muted-label">{data.files.length} items</span></div>{data.files.length ? <div className="file-list">{data.files.map((file) => <div className="file-row" key={file.id}><span className="file-icon"><Paperclip size={15} /></span><span className="file-copy"><strong>{file.original_name}</strong><small>{formatBytes(file.byte_size)} · {file.scan_state.replaceAll("_", " ")}</small></span>{canManageFiles && file.scan_state === "clean" && <button className="text-button" onClick={() => void onAction(async () => { await api(`/api/orgs/${request.organizationId}/files/${file.id}/visibility`, json("PATCH", { clientVisible: file.client_visible !== 1 })); await onRefresh(); }, file.client_visible ? "File hidden from client" : "File shared with client")}>{file.client_visible ? "Hide from client" : "Share"}</button>}{file.scan_state === "clean" && <button className="icon-button" onClick={() => download(file.id, file.original_name)} aria-label={`Download ${file.original_name}`}><ArrowDownUp size={15} /></button>}</div>)}</div> : <CompactEmpty title="No shared files yet" copy="Uploads are scanned before a PM can share them." />}{canWrite && <form className="file-upload-form" onSubmit={upload}><label className="upload-label"><Paperclip size={15} /><span>Add a file</span><input type="file" name="file" required accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,application/zip,.docx,.pptx" /></label><Button size="sm" type="submit" variant="outline">Upload</Button><small>Files stay private while they’re scanned.</small></form>}</div>
    <div className="detail-section"><div className="detail-section-heading"><div><span className="eyebrow">CONVERSATION</span><h3>Work it through together</h3></div></div><div className="comment-list">{data.comments.map((item) => <div className="comment-row" key={item.id}><span className="avatar mini-avatar">{initials(item.author_name)}</span><div><div className="comment-meta"><strong>{item.author_name}</strong><small>{formatDate(item.created_at)}</small>{item.visibility === "internal" && <Badge variant="outline">Internal</Badge>}</div><p>{item.body}</p></div></div>)}{data.comments.length === 0 && <CompactEmpty title="Start the conversation" copy="Ask a question or share a note on this request." />}</div>{canWrite && <form className="comment-compose" onSubmit={postComment}>{!clientRole && role !== "specialist" && <label className="sr-only" htmlFor="comment-visibility">Message visibility</label>}{!clientRole && role !== "specialist" && <select id="comment-visibility" className="comment-visibility-select" value={commentVisibility} onChange={(event) => setCommentVisibility(event.target.value as "client" | "internal")}><option value="client">Client-visible</option><option value="internal">Internal only</option></select>}{role === "specialist" && <span className="internal-note-label">Internal note</span>}<Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={role === "specialist" ? "Write an internal note for your team…" : "Write a comment…"} aria-label="Write a comment" maxLength={10000} /><Button type="submit" size="sm" disabled={saving || !comment.trim()} aria-label="Send comment"><Send size={14} /> Send</Button></form>}</div>
    <div className="detail-section timeline-section"><span className="eyebrow">RECENT HISTORY</span>{data.events.slice(0, 6).map((event, index) => <div className="timeline-row" key={`${event.created_at}-${index}`}><span className="timeline-dot" /><div><strong>{event.to_status ? `${statusLabel(event.from_status ?? "draft")} → ${statusLabel(event.to_status)}` : event.event_type.replaceAll("_", " ")}</strong><small>{event.reason || "Work updated"} · {formatDate(event.created_at)}</small></div></div>)}</div>
    </div><footer className="detail-footer"><span>Visible to the people who can access this organization.</span><button className="quiet-link" onClick={onClose}>Done <Check size={14} /></button></footer></DialogContent></DialogPortal></AccessibleDialog>;
}

function TaskComposer({ request, staff, onCreated, onAction }: { request: Request; staff: { id: string; display_name: string; global_role?: string }[]; onCreated: () => Promise<void>; onAction: (action: () => Promise<void>, success?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState(staff);
  const [specialistId, setSpecialistId] = useState("");
  useEffect(() => { if (open && team.length === 0) void api<{ specialists: { id: string; display_name: string }[] }>(`/api/orgs/${request.organizationId}/specialists`).then((result) => setTeam(result.specialists)); }, [open, request.organizationId, team.length]);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Assign specialist task</Button>;
  return <form className="task-compose" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onAction(async () => { await api(`/api/orgs/${request.organizationId}/requests/${request.id}/tasks`, json("POST", { title: form.get("title"), internalScope: form.get("internalScope"), specialistIds: specialistId ? [specialistId] : [] })); await onCreated(); setOpen(false); }, "Task assigned to specialist"); }}><label>Task title<Input name="title" required minLength={3} placeholder="What needs to be done?" /></label><label>Production context<Textarea name="internalScope" placeholder="Internal notes and references for the specialist." /></label><label>Assign to<select value={specialistId} onChange={(event) => setSpecialistId(event.target.value)} required><option value="">Choose a specialist</option>{team.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}</select></label><div><Button size="sm" type="submit" disabled={!specialistId}>Assign task</Button><button className="text-button" type="button" onClick={() => setOpen(false)}>Cancel</button></div></form>;
}

function TaskStateMenu({ task, onChange }: { task: Task; onChange: (task: Task, status: string, reason?: string) => void }) {
  const [reason, setReason] = useState("");
  if (task.status === "blocked") return <div className="unblock-form"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What changed?" aria-label="What changed to unblock this task" /><Button size="sm" variant="outline" onClick={() => onChange(task, "in_progress")}>Resume</Button></div>;
  if (task.status === "in_progress") return <div className="unblock-form"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is it blocked?" aria-label="Why is this task blocked" /><Button size="sm" variant="outline" disabled={!reason.trim()} onClick={() => onChange(task, "blocked", reason)}>Mark blocked</Button></div>;
  return null;
}

function RequestForm({ projects, onSubmit }: { projects: Project[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="form-grid" onSubmit={onSubmit}><FormField label="Project"><select name="projectId" required defaultValue=""><option value="" disabled>Select a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></FormField>{projects.length === 0 && <p className="form-footnote">Ask your project manager to create a project before you submit the first request.</p>}<FormField label="Request title"><Input name="title" required minLength={3} placeholder="A clear, short name for the work" /></FormField><div className="field-row"><FormField label="Service type"><Input name="serviceType" placeholder="Design, copy, development…" /></FormField><FormField label="Priority"><select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></FormField></div><FormField label="What would you like us to know?"><Textarea name="summary" placeholder="The context, audience and constraints." /></FormField><FormField label="What should this help achieve?"><Textarea name="objective" placeholder="Describe the goal or outcome." /></FormField><div className="field-row"><FormField label="Desired timing"><Input name="desiredTiming" placeholder="Optional · tell us what you have in mind" /></FormField><FormField label="Reference link"><Input name="references" type="url" placeholder="Optional · first reference" /></FormField></div><p className="form-footnote"><ShieldCheck size={14} />Your PM will review the request and confirm the brief before work is queued.</p><div className="form-action-row"><Button type="submit" name="submit" value="true" disabled={projects.length === 0}>Submit request <ArrowRight size={15} /></Button><Button type="submit" name="submit" value="false" variant="outline" disabled={projects.length === 0}>Save draft</Button></div></form>;
}

function ProjectForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <form className="form-grid" onSubmit={onSubmit}><FormField label="Project name"><Input name="name" required minLength={2} placeholder="e.g. Spring launch" /></FormField><FormField label="Summary"><Textarea name="summary" placeholder="A short description of the shared goal." /></FormField><Button type="submit">Create project <ArrowRight size={15} /></Button></form>; }
function MemberForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <form className="form-grid" onSubmit={onSubmit}><FormField label="Name"><Input name="displayName" required placeholder="Colleague’s name" /></FormField><FormField label="Email"><Input name="email" type="email" required placeholder="name@company.com" /></FormField><label className="check-field"><input type="checkbox" name="canSubmit" defaultChecked /> Can submit and collaborate on requests</label><label className="check-field"><input type="checkbox" name="canApprove" /> Can approve briefs and deliverables</label><Button type="submit">Add member <ArrowRight size={15} /></Button></form>; }
function StaffForm({ role, onSubmit }: { role: GlobalRole; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <form className="form-grid" onSubmit={onSubmit}><FormField label="Name"><Input name="displayName" required placeholder="Team member’s name" /></FormField><FormField label="Email"><Input name="email" type="email" required placeholder="name@zellinkstudio.com" /></FormField><FormField label="Role"><select name="role" defaultValue="pm"><option value="pm">Project manager</option><option value="specialist">Creative specialist</option>{role === "super_admin" && <><option value="admin">Admin</option><option value="super_admin">Super admin</option></>}</select></FormField><p className="form-footnote"><ShieldCheck size={14} />Admins and super admins can only be created by a super admin.</p><Button type="submit">Create account <ArrowRight size={15} /></Button></form>; }
function AccountAccessForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (reason: string) => void }) { return <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); if (reason.length >= 3) onSubmit(reason); }}><p>{disabled ? "This ends the user’s active sessions and blocks future sign-ins." : "This restores the user’s ability to sign in using their existing credentials."}</p><FormField label="Reason for this access change"><Textarea name="reason" required minLength={3} maxLength={500} placeholder="Record why access is changing" /></FormField><Button type="submit" variant={disabled ? "destructive" : "default"}>{disabled ? "Suspend account" : "Restore account"} <ArrowRight size={15} /></Button></form>; }

function ResetPasswordForm({ onSubmit }: { onSubmit: (reason: string) => void }) { return <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); if (reason.length >= 3) onSubmit(reason); }}><p>This revokes the user’s active sessions and issues a one-time password. The user must choose a new password at next sign-in.</p><FormField label="Reason for this reset"><Textarea name="reason" required minLength={3} maxLength={500} placeholder="Record why the password is being reset" /></FormField><Button type="submit">Issue temporary password <ArrowRight size={15} /></Button></form>; }

function PasswordChange({ actor, onDone }: { actor: Actor; onDone: () => void }) {
  const [message, setMessage] = useState(""); const [failed, setFailed] = useState(false);
  return <div className="password-change-wrap"><div className="password-change-card"><div className="signin-logo-mark"><ShieldCheck size={22} /></div><span className="eyebrow">FIRST SIGN IN</span><h1>Choose your password.</h1><p>{actor.displayName}, create a personal password before opening the workspace.</p><form className="form-grid" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get("password")); const confirm = String(form.get("confirmPassword")); if (password !== confirm) { setFailed(true); setMessage("Passwords do not match."); return; } void api("/api/auth/change-password", json("POST", { newPassword: password })).then(onDone).catch((cause) => { setFailed(true); setMessage(humanError(errorMessage(cause))); }); }}><FormField label="New password"><Input type="password" name="password" minLength={12} maxLength={128} autoComplete="new-password" required /></FormField><FormField label="Confirm password"><Input type="password" name="confirmPassword" minLength={12} maxLength={128} autoComplete="new-password" required /></FormField>{message && <p className={failed ? "form-error" : "form-success"} role="status">{message}</p>}<p className="form-footnote">Use at least 12 characters. Password recovery is not configured in this release.</p><Button type="submit">Set password <ArrowRight size={15} /></Button></form></div></div>;
}

function OneTimeSecret({ password, label, onDone }: { password: string; label: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="secret-panel"><div className="notice-banner"><span className="notice-icon"><ShieldCheck size={17} /></span><div><strong>Shown once</strong><p>Share this password through a channel you have agreed to use. The user must change it at first sign-in.</p></div></div><label className="secret-label">{label}<div className="secret-value"><code>{password}</code><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(password); setCopied(true); }}>{copied ? <Check size={14} /> : <FileText size={14} />}{copied ? "Copied" : "Copy"}</Button></div></label><Button onClick={onDone}>Done <Check size={14} /></Button></div>;
}

function PageHeading({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{copy}</p></div>{action && <div className="page-heading-action">{action}</div>}</div>; }
function StatCard({ label, value, caption, icon, tone, onClick }: { label: string; value: string | number; caption: string; icon: React.ReactNode; tone: string; onClick?: () => void }) { const inner = <><span className={`stat-icon ${tone}`}>{icon}</span><span className="stat-copy"><small>{label}</small><strong>{value}</strong><span>{caption}</span></span>{onClick && <ArrowUpRight className="stat-arrow" size={16} />}</>; return onClick ? <button className="stat-card stat-card-clickable" onClick={onClick}>{inner}</button> : <div className="stat-card">{inner}</div>; }
function FormField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="form-field"><span>{label}</span>{children}</label>; }
function Modal({ title, description, children, onClose }: { title: string; description?: string; children: React.ReactNode; onClose: () => void }) { return <AccessibleDialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogPortal><DialogOverlay className="modal-backdrop" /><DialogContent className="modal-card" showCloseButton={false} aria-labelledby="modal-title"><header className="modal-heading"><div><DialogTitle id="modal-title">{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</div><DialogClose asChild><button className="icon-button" aria-label="Close dialog"><X size={18} /></button></DialogClose></header><div className="modal-body">{children}</div></DialogContent></DialogPortal></AccessibleDialog>; }
function CompactEmpty({ title, copy }: { title: string; copy: string }) { return <div className="compact-empty"><span className="empty-spark"><Sparkles size={15} /></span><strong>{title}</strong><p>{copy}</p></div>; }
function EmptyState({ title, copy, action }: { title: string; copy: string; action?: React.ReactNode }) { return <Card className="empty-state surface-card"><span className="empty-state-icon"><Sparkles size={21} /></span><h2>{title}</h2><p>{copy}</p>{action}</Card>; }
function PriorityPill({ priority }: { priority: string }) { return <span className={`priority-pill priority-${priority}`}><i />{capitalize(priority)}</span>; }

function initials(value: string) { return value.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "Z"; }
function answerValue(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function roleLabel(role: GlobalRole) { return ({ client: "Client workspace", pm: "Project manager", specialist: "Creative specialist", admin: "Studio admin", super_admin: "Super admin" })[role]; }
function statusLabel(status: string | null) { if (!status) return "Draft"; return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function statusClass(status: string) { if (["approved", "delivered", "done", "complete", "clean"].includes(status)) return "badge-ready"; if (["client_review", "brief_ready", "revision_requested", "blocked", "paused"].includes(status)) return "badge-warm"; if (["in_progress", "internal_review"].includes(status)) return "badge-active"; if (["queued", "submitted", "pm_review"].includes(status)) return "badge-violet"; if (["cancelled", "failed", "infected"].includes(status)) return "badge-muted"; return "badge-neutral"; }
function formatDate(date: string) { const parsed = new Date(date); return Number.isNaN(parsed.valueOf()) ? "Recently" : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(parsed); }
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function timeOfDay() { const hour = new Date().getHours(); return hour < 12 ? "MORNING" : hour < 17 ? "AFTERNOON" : "EVENING"; }
function capitalize(value: string) { return value ? value[0]!.toUpperCase() + value.slice(1) : value; }
function errorMessage(cause: unknown) { return cause instanceof ApiError ? cause.code : cause instanceof Error ? cause.message : "unexpected_error"; }
function humanError(code: string) { return ({ unauthorized: "Your session has ended. Please sign in again.", forbidden: "You do not have access to this action.", organization_paused: "This plan is paused. Existing work can continue, but new work and lane starts are blocked.", onboarding_incomplete: "Finish onboarding with your project manager before submitting new work.", no_lane_available: "All active lanes are in use. This request will remain in the queue.", transition_not_configured: "This status change has not been configured for this organization.", approval_version_stale: "This approval belongs to an older version. Refresh and review the latest work.", request_changed_or_stale: "This request changed while you were viewing it. Refresh and try again.", upload_storage_unavailable: "The file store could not accept the upload. Try again in a moment.", file_scanning_not_configured: "File uploads will open after malware scanning is configured.", file_type_not_allowed: "That file type is not supported.", file_signature_mismatch: "The file contents don’t match the selected file type.", file_not_clean: "This file is not available until scanning finishes.", onboarding_checklist_incomplete: "Your project manager needs to finish every checklist item first.", current_password_invalid: "The current password did not match.", invalid_credentials: "The email or password is not correct." } as Record<string, string>)[code] ?? code.replaceAll("_", " "); }

export default App;
