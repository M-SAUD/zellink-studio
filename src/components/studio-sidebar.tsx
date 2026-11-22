import { CircleHelp, LogOut, MessageCircle, X, type LucideIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export type StudioNavigationItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
};

type StudioSidebarProps = {
  navigation: StudioNavigationItem[];
  activeView: string;
  inboxBadge?: string;
  organizations: { id: string; name: string }[];
  selectedOrganizationId: string;
  showOrganizationPicker: boolean;
  actorName: string;
  actorInitials: string;
  actorRole: string;
  onSelectView: (view: string) => void;
  onSelectOrganization: (organizationId: string) => void;
  onOpenReleaseNotes: () => void;
  onSignOut: () => void;
};

export function StudioSidebar({
  navigation,
  activeView,
  inboxBadge,
  organizations,
  selectedOrganizationId,
  showOrganizationPicker,
  actorName,
  actorInitials,
  actorRole,
  onSelectView,
  onSelectOrganization,
  onOpenReleaseNotes,
  onSignOut,
}: StudioSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const selectView = (view: string) => {
    onSelectView(view);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="offcanvas" className="studio-sidebar">
      <SidebarHeader className="studio-sidebar-header">
        <div className="studio-sidebar-brand">
          <span className="brand-mark">Z</span>
          <div><strong>Zellink</strong><small>Studio</small></div>
          <button className="studio-sidebar-close" type="button" onClick={() => setOpenMobile(false)} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent className="studio-sidebar-content">
        <SidebarGroup className="studio-sidebar-group">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <nav aria-label="Main navigation">
            <SidebarMenu>
              {navigation.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    type="button"
                    isActive={activeView === item.id}
                    aria-current={activeView === item.id ? "page" : undefined}
                    className="studio-nav-button"
                    onClick={() => selectView(item.id)}
                  >
                    <item.icon size={17} strokeWidth={1.7} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                  {item.badge && <SidebarMenuBadge className="studio-nav-badge">{item.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  isActive={activeView === "inbox"}
                  aria-current={activeView === "inbox" ? "page" : undefined}
                  className="studio-nav-button"
                  onClick={() => selectView("inbox")}
                >
                  <MessageCircle size={17} strokeWidth={1.7} />
                  <span>Inbox</span>
                </SidebarMenuButton>
                {inboxBadge && <SidebarMenuBadge className="studio-nav-badge">{inboxBadge}</SidebarMenuBadge>}
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
        </SidebarGroup>

        {showOrganizationPicker && organizations.length > 0 && (
          <div className="studio-sidebar-org">
            <label htmlFor="org-picker">Client</label>
            <select
              id="org-picker"
              value={selectedOrganizationId}
              onChange={(event) => onSelectOrganization(event.target.value)}
              aria-label="Select client organization"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="studio-sidebar-footer">
        <button className="studio-footer-action" type="button" onClick={onOpenReleaseNotes}>
          <CircleHelp size={17} strokeWidth={1.7} />
          <span>Release notes</span>
        </button>
        <div className="studio-profile-card">
          <span className="avatar">{actorInitials}</span>
          <div className="studio-profile-copy">
            <strong>{actorName}</strong>
            <small>{actorRole}</small>
          </div>
          <button className="studio-signout" type="button" onClick={onSignOut} aria-label="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
