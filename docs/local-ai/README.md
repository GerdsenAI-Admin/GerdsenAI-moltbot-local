# Local AI Integration

Moltbot supports running entirely on local AI infrastructure, eliminating the need for cloud API keys and providing full privacy for your conversations.

## Quick Start

### 1. Start Local Infrastructure

```bash
# Basic setup with Ollama + Chroma
docker compose -f docker/docker-compose.quickstart.yml up -d

# Pull a model
ollama pull mistral:7b-instruct
```

### 2. Enable Local AI Plugins

Add to your `moltbot.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434/v1",
        "apiKey": "ollama",
        "api": "openai-completions",
        "models": [{
          "id": "mistral:7b-instruct",
          "name": "Mistral 7B Instruct",
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }]
      }
    }
  },
  "plugins": {
    "enabled": [
      "local-ai-discovery",
      "vectordb-chroma",
      "tool-validator"
    ]
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/mistral:7b-instruct"
      }
    }
  }
}
```

### 3. Verify Setup

```bash
moltbot local-ai status
moltbot local-ai discover
```

## Supported Backends

| Backend | Port | Description | GPU Required |
|---------|------|-------------|--------------|
| **vLlama** | 11435 | Ollama + vLLM hybrid | NVIDIA |
| **LM Studio** | 1234 | Cross-platform GUI | Optional |
| **Ollama** | 11434 | Easy model management | Optional |
| **vLLM** | 8000 | High-throughput | NVIDIA |

## Extensions

### Local AI Discovery

Auto-discovers models from vLlama, LM Studio, and Ollama:

```json
{
  "plugins": {
    "local-ai-discovery": {
      "enabled": true,
      "backends": {
        "vllama": { "enabled": true },
        "lmstudio": { "enabled": true },
        "ollama": { "enabled": true }
      },
      "discoveryIntervalMs": 30000
    }
  }
}
```

CLI commands:
```bash
moltbot local-ai discover
moltbot local-ai status
moltbot local-ai config
```

### Vector Databases

**Chroma** (default):
```json
{
  "plugins": {
    "vectordb-chroma": {
      "host": "http://localhost:8000",
      "collectionName": "moltbot_memory"
    }
  }
}
```

**Qdrant** (alternative):
```json
{
  "plugins": {
    "vectordb-qdrant": {
      "url": "http://localhost:6333",
      "collectionName": "moltbot_memory",
      "vectorSize": 1536
    }
  }
}
```

### Reranking

Improves RAG quality with cross-encoder reranking:

```json
{
  "plugins": {
    "reranker": {
      "provider": "local",
      "local": {
        "baseUrl": "http://localhost:8080"
      },
      "topK": 10
    }
  }
}
```

Supported providers:
- `local` - Local cross-encoder (BGE Reranker)
- `cohere` - Cohere Rerank API
- `jina` - Jina AI Reranker
- `huggingface` - HuggingFace Inference API

### Document Ingestion

Ingest PDF, DOCX, and other documents:

```bash
moltbot docs ingest report.pdf
moltbot docs batch ./documents --recursive
```

Configuration:
```json
{
  "plugins": {
    "document-ingest": {
      "addToMemory": true,
      "supportedFormats": ["pdf", "docx", "txt", "md", "html"]
    }
  }
}
```

### Tool Validation

Validates and repairs tool calls from local models:

```json
{
  "plugins": {
    "tool-validator": {
      "repairStrategy": "coerce",
      "blockDangerousCalls": true,
      "allowToolNameFuzzyMatch": true
    }
  }
}
```

## Docker Compose Files

| File | Use Case | Platform |
|------|----------|----------|
| `docker-compose.quickstart.yml` | Minimal setup (Ollama + Chroma) | All |
| `docker-compose.local-ai.yml` | Full local AI stack | Linux/macOS |
| `docker-compose.gpu.yml` | GPU-accelerated with vLLM | Linux (NVIDIA) |
| `docker-compose.windows.yml` | Windows-optimized setup | Windows |

### Windows Setup

Windows users should use the Windows-specific compose file:

```powershell
# Start with Docker Desktop (WSL2 backend required)
docker compose -f docker/docker-compose.windows.yml up -d

# Pull a model
docker exec -it moltbot-ollama ollama pull mistral:7b-instruct
```

**Windows Requirements:**
- Docker Desktop with WSL2 backend
- For GPU: NVIDIA drivers on Windows + NVIDIA Container Toolkit in WSL2

**Windows Limitations:**
- vLlama is not available (requires NVIDIA Linux containers)
- LM Studio must be installed natively (not in Docker)
- GPU passthrough requires WSL2 + NVIDIA Container Toolkit

**Recommended Windows Setup:**
1. Use `docker-compose.windows.yml` for Ollama + Chroma
2. Install LM Studio natively for additional models
3. Configure moltbot to use both:

```json
{
  "models": {
    "providers": {
      "ollama": { "baseUrl": "http://localhost:11434/v1" },
      "lmstudio": { "baseUrl": "http://localhost:1234/v1" }
    }
  }
}
```

### GPU Setup (Linux)

```bash
# Full GPU stack with vLLM
docker compose -f docker/docker-compose.gpu.yml up -d

# With vector databases
docker compose -f docker/docker-compose.gpu.yml --profile vectordb up -d

# With reranker
docker compose -f docker/docker-compose.gpu.yml --profile reranker up -d
```

## Hardware Recommendations

| Model Size | VRAM Required | Recommended GPU |
|------------|---------------|-----------------|
| 7B | 8GB | RTX 3070, RTX 4060 |
| 13B | 12GB | RTX 4070, RTX 3080 |
| 32B | 24GB | RTX 4090, A10 |
| 70B | 48GB+ | 2x RTX 4090, A100 |

### Apple Silicon

LM Studio with MLX backend is recommended:
- M1/M2 (16GB): Up to 13B models
- M1/M2 Pro (32GB): Up to 32B models
- M1/M2 Max (64GB): Up to 70B models
- M4 Pro (48GB): 32B comfortable, 70B with quantization

## Model Recommendations

### For Tool Calling

| Model | Tool Support | Notes |
|-------|--------------|-------|
| Qwen 2.5 Instruct | Excellent | Best for function calling |
| Mistral Instruct | Good | Fast, reliable |
| Llama 3.1/3.2 | Good | Requires proper prompting |
| DeepSeek-R1 | Partial | Strong reasoning |
| Nemotron | Good | Via vLLM |

### For RAG/Memory

| Model | Context | Notes |
|-------|---------|-------|
| Qwen 2.5 32B | 128K | Best quality |
| Mistral 7B | 32K | Fast, good quality |
| Phi-3 | 128K | Small but capable |

## Combined Deployments

### Running Gateway with Local AI

To run the Moltbot gateway container alongside local AI services, you need to ensure both services can communicate. There are two approaches:

**Option 1: Shared Network (Recommended)**

Add the gateway to the local-ai network:

```bash
# Start local AI services
docker compose -f docker/docker-compose.local-ai.yml up -d

# Start gateway with network connection
docker compose -f docker-compose.yml up -d
docker network connect moltbot-local-ai moltbot-gateway
```

**Option 2: Multi-file Compose**

Use multiple compose files together:

```bash
# Combined startup
docker compose \
  -f docker-compose.yml \
  -f docker/docker-compose.local-ai.yml \
  up -d
```

Then configure your `moltbot.json` to use the container hostnames:

```json
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://moltbot-ollama:11434/v1"
      }
    }
  },
  "plugins": {
    "vectordb-chroma": {
      "host": "http://moltbot-chroma:8000"
    }
  }
}
```

### Running Local AI with Native Gateway

If running the gateway natively (not in Docker), use `localhost` URLs:

```json
{
  "models": {
    "providers": {
      "ollama": { "baseUrl": "http://localhost:11434/v1" },
      "lmstudio": { "baseUrl": "http://localhost:1234/v1" }
    }
  },
  "plugins": {
    "vectordb-chroma": { "host": "http://localhost:8000" },
    "vectordb-qdrant": { "url": "http://localhost:6333" }
  }
}
```

### Full Stack Example

Complete setup with GPU inference, vector database, and reranking:

```bash
# Linux with NVIDIA GPU
docker compose -f docker/docker-compose.gpu.yml --profile vectordb --profile reranker up -d

# Windows with WSL2 + NVIDIA
docker compose -f docker/docker-compose.windows-gpu.yml up -d

# macOS (CPU-only, use LM Studio natively for GPU)
docker compose -f docker/docker-compose.quickstart.yml up -d
```

## Troubleshooting

### "No models found"

1. Check if backend is running:
   ```bash
   curl http://localhost:11434/api/version
   ```

2. Pull a model:
   ```bash
   ollama pull mistral:7b-instruct
   ```

### Tool calling errors

Enable the tool-validator plugin:
```json
{
  "plugins": {
    "tool-validator": {
      "repairStrategy": "coerce",
      "logValidationErrors": true
    }
  }
}
```

### Slow inference

1. Use GPU acceleration (vLLM or Ollama with CUDA)
2. Reduce model size or use quantization
3. Enable KV cache (`--enable-prefix-caching` for vLLM)

### Memory issues

1. Reduce `contextWindow` in model config
2. Use smaller model or more aggressive quantization
3. Set `OLLAMA_MAX_LOADED_MODELS=1`
