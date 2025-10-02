<div align="center">
  <img src="public/logo.png" alt="SupaConsole Logo" height="50">
  <br />
  <br />
  A modern, self-hosted dashboard for managing multiple Supabase projects with Docker. Built with Next.js, TypeScript, and Tailwind CSS.
  <br />
  <br />
  
  ![SupaConsole Demo](public/demo.png)
  
  *SupaConsole Dashboard - Manage multiple Supabase projects with ease*
</div>

## ✨ Features

- **🎯 Project Management**: Create, configure, and manage multiple Supabase instances
- **🐳 Docker Integration**: Automated Docker Compose deployment for each project  
- **⚙️ Environment Configuration**: Web-based interface for configuring project environment variables
- **🔗 Service URLs**: Quick access to all running services (Studio, API, Analytics, Database)
- **🗑️ Safe Project Deletion**: Complete cleanup with Docker container removal and file system cleanup
- **👥 Team Management**: User authentication and team member management
- **📧 Email Integration**: Password reset and team invitation emails via SMTP
- **🎨 Modern UI**: Dark theme with responsive design using shadcn/ui components
- **🔒 Secure Authentication**: Built-in user authentication with session management
- **📊 Project Status Tracking**: Monitor project status (active, paused, stopped)
- **⚡ Unique Port Management**: Automatic port allocation to prevent conflicts between projects

## 🛠️ Tech Stack

- **Frontend**: Next.js 15, TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Next.js API Routes, Prisma ORM
- **Database**: SQLite (easily configurable for PostgreSQL)
- **Authentication**: Custom JWT-based authentication
- **Email**: Nodemailer with SMTP support
- **Containerization**: Docker & Docker Compose
- **Styling**: Dark theme with custom color palette

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- Docker and Docker Compose
- Git
- SMTP email service (Gmail, SendGrid, etc.)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/supaconsole.git
   cd supaconsole
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   # Database
   DATABASE_URL="file:./dev.db"
   
   # Authentication
   NEXTAUTH_SECRET="your-secret-key-here"
   NEXTAUTH_URL="http://localhost:3000"
   
   # SMTP Configuration
   SMTP_HOST="smtp.gmail.com"
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER="your-email@gmail.com"
   SMTP_PASS="your-app-password"
   
   # Supabase Core Repository
   SUPABASE_CORE_REPO_URL="git clone --depth 1 https://github.com/supabase/supabase"
   
   # Application
   APP_NAME="SupaConsole Dashboard"
   APP_URL="http://localhost:3000"
   ```

4. **Set up the database**
   ```bash
   npm run db:push
   npm run db:generate
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

6. **Open your browser**
   Navigate to [http://localhost:3000](http://localhost:3000)

## 📖 Usage

### First Time Setup

1. **Register an account** at `/auth/register`
2. **Initialize the workspace** by clicking the "Initialize" button on the dashboard
3. This will:
   - Create a `supabase-core` directory with the Supabase repository
   - Create a `supabase-projects` directory for your projects

### Creating a Project

1. Click **"New Project"** on the dashboard
2. Enter your project name and description
3. Configure environment variables through the web interface
4. The system will:
   - Create a unique project directory
   - Copy Docker files from `supabase-core`
   - Generate environment configuration
   - Run `docker compose pull` and `docker compose up -d`

### Managing Projects

- **View Projects**: All projects are displayed on the main dashboard with status indicators
- **Project Management Modal**: Click "Manage" on any project to access:
  - **Service URLs**: Direct links to Supabase Studio, API Gateway, Analytics, and Database
  - **Configure**: Quick access to environment variable configuration
  - **Safe Deletion**: Complete project removal with confirmation and cleanup
- **Environment Variables**: Update configuration through the web interface
- **Docker Operations**: Automatic container management with unique naming and ports
- **Real-time Status**: Monitor project status (active, paused, stopped)

## 🏗️ Project Structure

```
supaconsole/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/               # API routes
│   │   ├── auth/              # Authentication pages
│   │   └── dashboard/         # Dashboard pages
│   ├── components/            # React components
│   ├── lib/                   # Utility functions
│   │   ├── auth.ts           # Authentication utilities
│   │   ├── db.ts             # Database connection
│   │   ├── email.ts          # Email services
│   │   └── project.ts        # Project management
│   └── generated/            # Prisma client
├── prisma/                   # Database schema
├── public/                   # Static assets
└── supabase-core/           # Cloned Supabase repository (created on init)
└── supabase-projects/       # Individual project directories (created on init)
```

## 🔧 Development

### Available Scripts

```bash
# Development
npm run dev              # Start development server with Turbopack
npm run build           # Build for production
npm run start           # Start production server

# Database
npm run db:generate     # Generate Prisma client
npm run db:push         # Push schema changes to database
npm run db:studio       # Open Prisma Studio
npm run db:reset        # Reset database (⚠️ destructive)

# Code Quality
npm run lint            # Run ESLint
npm run type-check      # TypeScript type checking
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | `file:./dev.db` |
| `NEXTAUTH_SECRET` | JWT secret key | `your-secret-key` |
| `SMTP_HOST` | SMTP server hostname | `smtp.gmail.com` |
| `SMTP_USER` | SMTP username | `your-email@gmail.com` |
| `SMTP_PASS` | SMTP password/app password | `your-app-password` |
| `SUPABASE_CORE_REPO_URL` | Supabase repo URL | `https://github.com/supabase/supabase` |

## 🐳 Docker Integration

The application manages Docker containers for each Supabase project:

1. **Initialization**: Clones Supabase repository to `supabase-core/`
2. **Project Creation**: Copies `docker/` folder to project directory
3. **Environment Setup**: Creates `.env` files from web interface
4. **Container Management**: Runs `docker compose` commands automatically

## 📧 Email Configuration

### Gmail Setup
1. Enable 2-factor authentication
2. Generate an App Password
3. Use the App Password in `SMTP_PASS`

### Other Providers
- **SendGrid**: Use API key as password
- **AWS SES**: Use SMTP credentials
- **Custom SMTP**: Any SMTP-compatible service

## 🚀 Deployment

### Production Build

```bash
npm run build
npm run start
```

### Docker Deployment

Use the included Dockerfile for production. Ensure persistence and Docker socket access:

```bash
# Build image
docker build -t supaconsole .

# Run with persistent SQLite and Docker socket (for Supabase project management)
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL="file:/app/data/db.sqlite" \
  -e NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
  -v "$PWD/data:/app/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name supaconsole \
  supaconsole
```

Optional additional volumes:

- `/app/supabase-core` – cached Supabase repo clone
- `/app/supabase-projects` – per-project Docker files

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Commit changes: `git commit -m 'Add amazing feature'`
5. Push to branch: `git push origin feature/amazing-feature`
6. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

<div align="center">
  <strong>Built with ❤️ for the Supabase community</strong>
</div>
