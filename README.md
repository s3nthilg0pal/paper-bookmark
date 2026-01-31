# 📚 Paper Bookmark

A lightweight, self-hostable research paper bookmarking system. Save, organize, and quickly access your research papers from any device.

![Paper Bookmark](https://img.shields.io/badge/self--hosted-NoSQL-blue) ![Node.js](https://img.shields.io/badge/node-%3E%3D22-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue) ![Docker](https://img.shields.io/badge/docker-ready-blue)

## ✨ Features

- **📱 Mobile-First Design** - Responsive UI that works on any device
- **🔍 Smart Search** - Search by title, authors, abstract, or tags
- **🏷️ Tag Organization** - Organize papers with custom tags
- **📥 Auto-Fetch Metadata** - Automatically fetch paper info from arXiv
- **🗄️ Lightweight NoSQL** - Uses LokiJS, a lightweight embedded database
- **🐳 Docker Ready** - Easy self-hosting with Docker
- **⌨️ Keyboard Shortcuts** - Quick access with Ctrl+K (search), Ctrl+N (new)
- **🔷 TypeScript** - Fully typed codebase for better maintainability

## 🚀 Quick Start

### Option 1: Run with Node.js

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start

# Or for development with auto-reload
npm run dev
```

Open http://localhost:3000 in your browser.

### Option 2: Run with Docker

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t paper-bookmark .
docker run -d -p 3000:3000 -v paper-data:/app/data paper-bookmark
```

### Option 3: Deploy with Kubernetes + ArgoCD

#### Prerequisites
- Kubernetes cluster
- ArgoCD installed
- Container registry access

#### Quick Deploy

```bash
# Build and push Docker image
docker build -t your-registry/paper-bookmark:latest .
docker push your-registry/paper-bookmark:latest

# Update image in kustomization.yaml
# Edit k8s/kustomization.yaml and set your image name

# Apply ArgoCD Application
kubectl apply -f argocd/appproject.yaml
kubectl apply -f argocd/application.yaml
```

#### Manual Kubernetes Deploy (without ArgoCD)

```bash
# Apply all manifests using Kustomize
kubectl apply -k k8s/

# Or apply individually
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# Get LoadBalancer external IP
kubectl get svc -n paper-bookmark
```

#### Kubernetes Structure

```
k8s/
├── kustomization.yaml   # Kustomize config (ArgoCD compatible)
├── namespace.yaml       # Namespace definition
├── configmap.yaml       # Environment configuration
├── pvc.yaml             # Persistent storage for database
├── deployment.yaml      # App deployment
└── service.yaml         # LoadBalancer service

argocd/
├── application.yaml     # ArgoCD Application manifest
└── appproject.yaml      # ArgoCD Project definition
```

## 📖 API Documentation

### Papers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/papers` | Get all papers (supports `?search=`, `?tag=`, `?sort=`, `?order=`) |
| GET | `/api/papers/:id` | Get single paper |
| POST | `/api/papers` | Create new paper |
| PUT | `/api/papers/:id` | Update paper |
| DELETE | `/api/papers/:id` | Delete paper |
| POST | `/api/papers/:id/access` | Track paper access |

### Tags

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tags` | Get all unique tags |

### Metadata

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/fetch-metadata` | Fetch paper metadata from URL |

### Paper Object

```json
{
  "_id": "unique-id",
  "url": "https://arxiv.org/abs/2301.00001",
  "title": "Paper Title",
  "authors": "Author One, Author Two",
  "abstract": "Paper abstract or notes...",
  "tags": ["machine-learning", "nlp"],
  "source": "arXiv",
  "dateAdded": "2026-01-31T10:00:00.000Z",
  "lastAccessed": "2026-01-31T12:00:00.000Z",
  "accessCount": 5
}
```

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Focus search |
| `Ctrl/Cmd + N` | Add new paper |
| `Escape` | Close modal |

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Database**: NeDB (embedded NoSQL)
- **Frontend**: Vanilla HTML/CSS/JS
- **Containerization**: Docker

## 📁 Project Structure

```
paper-bookmark/
├── server.js          # Express API server
├── package.json       # Node.js dependencies
├── Dockerfile         # Docker image
├── docker-compose.yml # Docker Compose config
├── data/              # Database files (auto-created)
│   └── papers.db      # NeDB database
└── public/            # Frontend files
    ├── index.html     # Main HTML
    ├── styles.css     # Mobile-first CSS
    └── app.js         # Frontend JavaScript
```

## 🌐 Supported Sources

The system auto-detects paper sources:
- arXiv (with metadata fetching)
- IEEE
- ACM
- Springer
- Nature
- ScienceDirect
- PubMed
- Semantic Scholar
- OpenReview
- GitHub
- Generic Web

## 📝 License

MIT License - feel free to use and modify!
