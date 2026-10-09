# Super Admin (server side)

Everything only the seller can touch lives in this folder.

## Files

- `admin.routes.ts` — all `/api/admin/*` endpoints (overview, workspaces, plan,
  suspend, per-workspace AI key, cross-workspace payment claims).
- Auth gate: `requireSuperAdmin` in `../middleware/auth.ts`
  (UID in `SUPER_ADMIN_UIDS` **or** email in `SUPER_ADMIN_EMAILS`).
- Key storage: AES-256-GCM encrypted (`aiApiKeyEnc` in `botSettings`), masked as
  `••••ab12` in every response. Full keys never leave the server.

## Env (Render + local server/.env)

```
SUPER_ADMIN_UIDS=<firebase uid>
SUPER_ADMIN_EMAILS=owner@email.com
```

## Suspend enforcement

- API: `requireWorkspace` returns 403 `WORKSPACE_SUSPENDED` (super-admin bypasses).
- Webhook: incoming stored, but no AI reply while suspended.
