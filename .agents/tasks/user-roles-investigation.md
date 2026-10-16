# User Roles Investigation Report — BrgyPULSE-System (SIGLA)

## Summary

The system defines **6 user roles** stored as a plain `VARCHAR(32)` column in the `user` table (no database enum). All role values are lowercase strings. Authorization is enforced through a combination of JWT-based middleware (`middleware.ts`), an auth-middleware helper (`src/lib/auth-middleware.ts`), a permissions library (`src/lib/permissions.ts`), and a React `ProtectedRoute` component. There are **no Supabase RLS policies that gate access by application role** — RLS on Supabase tables is authenticated-user-level (anyone with a valid session), while application-level access control lives entirely in Next.js.

A notable historical change: the `viewer` role was renamed to `officer` in November 2024 as part of the CPAP module migration, but `viewer` still appears in several places (`reinstate-viewer-role.sql`, the `roleOptions` array in `users-roles.tsx`, and the `UserRole` type in `permissions.ts`).

---

## 1. Roles and Their Values

| Role Value | Display Name | Description |
|---|---|---|
| `admin` | Administrator | Full system access |
| `developer` | Developer | Full access; bypasses all role guards; dev/testing use |
| `officer` | Officer / LGU Officer | Formerly `viewer`; designated to a specific barangay; manages CPAP |
| `fs` | Field Supervisor | Manages survey assignments and spot workflows |
| `interviewer` | Interviewer | Conducts surveys and collects field data |
| `viewer` | Viewer | Read-only legacy role; deprecated in favour of `officer` (Nov 2024) |

Sources:
- `src/lib/permissions.ts` — `export type UserRole = 'admin' | 'developer' | 'officer' | 'viewer' | 'fs' | 'interviewer';`
- `src/app/settings/ui/sections/users-roles.tsx` — `const roleOptions = ["admin", "fs", "interviewer", "officer", "viewer"];`
- `src/app/api/users/[id]/route.ts` — validation array `['admin', 'fs', 'interviewer', 'officer', 'developer']`

---

## 2. Where Roles Are Defined

### Database Schema

**Prisma schema** (`prisma/schema.prisma`):
```prisma
model User {
  role  String?  @default("officer") @db.VarChar(32)
  ...
}
```
No database enum — roles are free-text strings with a default of `"officer"`.

**Legacy MySQL dump** (`database/sigla_db.sql`):
```sql
CREATE TABLE `user` (
  `role` varchar(32) DEFAULT 'Viewer',
  ...
)
```
The dump was generated before the viewer→officer migration, so the default there is still `'Viewer'`.

**Seed data in `sigla_db.sql`** shows these roles: `Admin`, `Interviewer`, `Viewer`.

### TypeScript Type

`src/lib/permissions.ts`:
```typescript
export type UserRole = 'admin' | 'developer' | 'officer' | 'viewer' | 'fs' | 'interviewer';
```
This is a union type (not an enum), used for type-checking the permissions utility functions.

---

## 3. Authorization / Access Control

### JWT Token

Login (`src/app/api/login/route.ts`) signs a JWT with the user's role:
```typescript
const token = jwt.sign({
  id, firstName, lastName, email,
  role: (user.role || 'officer').toLowerCase(),
  barangayDesignation,
}, JWT_SECRET, { expiresIn: '7d' });
```
The token is stored as an `HttpOnly` cookie named `pulse_token`.

### Next.js Middleware (`middleware.ts`)

Protects page routes by verifying the JWT on every request to `/dashboard/*`, `/survey/*`, `/fs-dashboard/*`, `/cpap/*`, `/admin/*`, `/settings/*`, `/tools/*`, `/reportcard/*`. Injects `x-user-role`, `x-user-id`, `x-user-email` headers downstream. **Does not do per-role routing** at the middleware level — that happens in `ProtectedRoute` components and API handlers.

### API Middleware Helper (`src/lib/auth-middleware.ts`)

Four exported functions used by API route handlers:
- `verifyAuth(request)` — verifies JWT, returns user object
- `requireAuth(request)` — returns error result if not authenticated
- `requireAdmin(request)` — returns error if role is not `admin` or `developer`
- `requireWritePermission(request)` — returns error if role is `viewer`

Default role fallback: `(decoded.role || 'officer').toLowerCase()`

### Permissions Library (`src/lib/permissions.ts`)

Centralised pure-function helpers for React components and API routes:

| Function | Allowed Roles |
|---|---|
| `isAdminOrDeveloper` | `admin`, `developer` |
| `isViewer` | `viewer` |
| `canPerformWriteOperations` | everyone except `viewer` |
| `canAccessMainDashboard` | all authenticated |
| `canAccessCPAPDashboard` | `admin`, `developer`, `officer`, `viewer` |
| `canEditCPAP` | `admin`, `developer`, `officer` |
| `canSubmitCPAP` | `admin`, `developer`, `officer` |
| `canAccessBackupSettings` | all authenticated |
| `canAccessAdminSettings` | `admin`, `developer` |
| `canPerformSurveyOperations` | everyone except `viewer` |
| `canManageUsers` | `admin`, `developer` |
| `canManageBarangays` | `admin`, `developer` |
| `canManageSurveyCycles` | `admin`, `developer` |

### React Hook (`src/hooks/usePermissions.ts`)

Wraps the permissions library, uses `useAuth()` to get the current user, and exposes the full set of boolean checks to components.

### ProtectedRoute Component (`src/components/auth/ProtectedRoute.tsx`)

Client-side page guard. Key behaviour: **`developer` role bypasses all `allowedRoles` checks**:
```typescript
if (userRole !== 'developer' && !allowedRoles.includes(userRole)) {
  router.push('/forbidden?reason=insufficient_permissions');
}
```

Page-level role gates (from codebase):

| Page / Route | Allowed Roles |
|---|---|
| `/dashboard` | `admin`, `developer`, `fs`, `officer`, `viewer` |
| `/fs-dashboard` | `admin`, `developer`, `fs` |
| `/admin/cpap` | `admin`, `developer` |
| `/admin/cpap/review/[id]` | `admin`, `developer` |
| `/cpap` | `officer`, `admin`, `developer`, `viewer` (enforced inside component) |
| `/survey`, `/survey/barangay/[id]`, `/survey/forms` | all authenticated |
| `/settings` | all authenticated (further restricted inside by permissions hook) |

---

## 4. Role-Related Database Migrations / SQL Files

| File | Purpose |
|---|---|
| `database/add-developer-role.sql` | Adds a seed developer user; documents developer role permissions |
| `database/reinstate-viewer-role.sql` | Re-adds viewer role sample user; documents viewer permissions |
| `database/README-ROLE-MIGRATION.md` | Documents viewer→officer migration |
| `database/ROLE-MIGRATION-COMPLETE.md` | Migration completion summary |
| `database/ROLE-MIGRATION-CORRECTED.md` | Corrects to lowercase role values |
| `prisma/migrations/20251119081816_.../migration.sql` | Formal Prisma migration that changes default from `viewer` to `officer` and updates existing data |

No migration creates a database-level enum for roles. The role column is always `VARCHAR(32)`.

**Supabase RLS** exists on `cpap_comments`, `cpap_notifications`, `cycle_awards`, `backup_history`, `ml_cache`, `gemini_settings` tables, but all policies are based on `auth.role() = 'authenticated'` or `auth.uid()` — **not on application roles**. The application enforces role checks at the Next.js layer before ever hitting those tables.

---

## 5. How Roles Are Assigned to Users

| Path | Default Role | Notes |
|---|---|---|
| Self-registration (`/api/register`) | `officer` | Hardcoded: `role: "officer"` |
| Admin creates user (Settings → Users & Roles) | `officer` | Default in form; admin can choose any role in `roleOptions` |
| Admin edits user (Settings → Users & Roles) | — | Admin can change to: `admin`, `fs`, `interviewer`, `officer`, `viewer` |
| Data seed (`database/sigla_db.sql`) | varies | Seeds include `Admin`, `Interviewer`, `Viewer` |

The `developer` role is **not in the `roleOptions` array** in the admin UI (`users-roles.tsx`), so it can only be assigned directly in the database or via the `add-developer-role.sql` script. The update API (`/api/users/[id]`) does accept `developer` in its validation array.

**Officer-specific assignment**: Officers have a `barangayDesignation` field (FK to `barangay`) that restricts which CPAP records they can access/edit. When editing an Officer user in the admin UI, a barangay selector appears.

**FS/Interviewer assignment**: Uses the `assignment` table (barangay → user → survey_cycle) to determine which barangay an FS or interviewer is working in.

---

## 6. UI Components That Render Differently by Role

| Component / Page | Behaviour |
|---|---|
| `UserDropdown.tsx` | Shows "CPAP Submission" only for `officer`; shows "CPAP Management" only for `admin`; hides "System Settings" and "Survey Dashboard" from `officer` |
| `MapView.tsx` | Officers default to list view; admin/viewer/others default to map view; only `officer`, `admin`, `viewer` can toggle between map and list |
| `CycleSelectorDropdown.tsx` | Cycle change only allowed for `admin` |
| `SurveyAnalyticsDashboard.tsx` / `DetailedResponsesView.tsx` | Checks `isAdmin` flag (`admin` or `developer`) to show admin-only controls |
| `survey/page.tsx` | Settings link shown only for `admin`; spots tab shown only for `interviewer`, `admin`, `fs`, `developer` |
| `survey/barangay/[id]/page.tsx` | Delete buttons for responses only shown for `admin` |
| `reportcard/page.tsx` | "Governance Integrity Snapshot" section only shown for `admin` |
| `settings/page.tsx` | Sections filtered by `canAccessAdminSettings` (admin/developer only) vs. `canAccessBackupSettings` (all); admin sidebar uses the same filter |
| `cpap/page.tsx` | Shows viewer notice banner for `viewer` role; edit/submit actions gated by `canEditCPAP` / `canSubmitCPAP` |
| `users-roles.tsx` (Settings) | Role badges coloured by role; barangay selector appears only for `officer` users |

---

## Conclusions & Recommendations

### Findings

1. **Six roles exist**: `admin`, `developer`, `officer`, `fs`, `interviewer`, `viewer`. The `viewer` role is technically deprecated (migration to `officer` in Nov 2024) but still present in code (`UserRole` type, `roleOptions`, migration SQL).

2. **No database enum** — roles are unconstrained strings. A typo in the role column value would silently deny access rather than fail visibly.

3. **`developer` role is a super-admin bypass** — it is not assignable through the admin UI, which is good, but it is still a live code path that skips all permission checks. It should be removed from production builds or at minimum blocked at middleware.

4. **Supabase RLS does not enforce application roles** — all RLS policies use `auth.role() = 'authenticated'`, meaning any authenticated Supabase user can read/write those tables. Application-level enforcement in Next.js is the only real gate.

5. **`viewer` role inconsistency**: The permissions library still includes `viewer` and the admin UI `roleOptions` array includes `viewer`. The Prisma default and API register both use `officer`. If a viewer user exists in the database, the system partially handles them (read-only for CPAP, blocked from write operations) but `canAccessCPAPDashboard` and `canEditCPAP` logic treats viewer as allowed to view but not edit, which is fine functionally, yet the intent was to deprecate this role.

6. **`developer` missing from `roleOptions`** in the admin UI — this is intentional but inconsistency exists: `ROLE-MIGRATION-CORRECTED.md` lists only four roles, while the code supports six.

7. **JWT default role fallback** is `officer` in `auth-middleware.ts` — if someone's JWT somehow lacks a `role` claim they get officer access, which is reasonable but worth noting.

### Recommendations

1. **Add a database CHECK constraint** on the `role` column to prevent typos:
   ```sql
   ALTER TABLE "user" ADD CONSTRAINT role_valid
     CHECK (role IN ('admin', 'developer', 'officer', 'fs', 'interviewer', 'viewer'));
   ```

2. **Remove `viewer` from the `UserRole` type and `roleOptions`** if the migration to `officer` is complete, or clearly document that `viewer` is intentionally kept as a legacy read-only role with separate semantics from `officer`.

3. **Block `developer` role in production**: Add a middleware check that rejects `developer`-role logins outside of a development environment (`NODE_ENV !== 'development'`), or remove the developer bypass from `ProtectedRoute` before production deployment.

4. **Strengthen Supabase RLS** to enforce application roles (e.g., using a `user_role` claim in the JWT stored in Supabase Auth, or checking the `user` table via a security definer function), so the Supabase layer is not a flat "any authenticated user" gate.

5. **Align `developer` in the user update API validation**: Currently `src/app/api/users/[id]/route.ts` accepts `developer` as a valid role update via the API, even though the admin UI doesn't expose it. Either expose it consistently or remove it from the API validation to prevent accidental elevation.
