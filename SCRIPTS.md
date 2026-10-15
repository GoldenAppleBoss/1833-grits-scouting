# Runtime commands

This folder contains only the active Vercel/Supabase runtime, configuration,
migrations and setup documentation. It is outside the original tools repository.
Tests, Docker files, Git metadata, secrets, dependencies and Azure files are omitted.

Run from this folder with Node.js 22 installed:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
Copy-Item .env.example .env.local
```

Edit .env.local privately using HOSTING.md before running database commands:

```powershell
npm.cmd run db:migrate
npm.cmd run dev
npm.cmd run admin:grant -- your-existing-signup-email@example.org
```

To begin a separate repository here:

```powershell
git init -b main
git add .
git commit -m "Initial Vercel and Supabase stack"
```

Connect the desired remote using your Git provider or IDE. Use this folder as
the Vercel project root, and configure its environment variables separately.
The same Supabase project can retain existing users and data; source export
does not copy or change database contents. Use npm instead of npm.cmd on macOS/Linux.