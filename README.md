# 🎙️ Speaker Identification using Voice audio embeddings and Azure AI Search or Qdrant

<img src="image1.png">

<div align="center">

![Speaker Identification](https://img.shields.io/badge/🎙️%20Speaker%20Identification-Advanced%20Audio%20Processing-2E86AB?style=for-the-badge)
![Embeddings](https://img.shields.io/badge/Embeddings-Vector%20Search-A23B72?style=for-the-badge)
![Azure](https://img.shields.io/badge/Azure-Cloud%20Ready-0078D4?style=for-the-badge)

</div>

---

![GitHub](https://img.shields.io/badge/repo-speaker--identification-blue)
![Language](https://img.shields.io/badge/language-Python%20%7C%20JavaScript%20%7C%20Jupyter-orange)
![Status](https://img.shields.io/badge/status-Active-brightgreen)

Speaker identification with embeddings and Azure AI Search or Qdrant for edge applications.

## Architecture Overview

<img src="image2.png">

## Overview

This repository contains implementations and experiments for **speaker identification** tasks using modern embedding techniques and vector search technologies. It includes the original Jupyter workflows and a local, browser-based application for interactive identification, enrollment, visualization, and report export.

## Key Features

- **Speaker Identification**: Identify speakers from audio embeddings
- **Embedding Generation**: Create vector representations of speaker characteristics
- **Azure AI Search Integration**: Use Azure's search capabilities for speaker matching
- **Qdrant Support**: Alternative vector database for storing and searching embeddings
- **Audio Processing**: Handle and process audio data for speaker recognition
- **Voice Verification**: Verify speaker identity from voice samples
- **Interactive Web Application**: Run a guided FastAPI and browser workflow locally
- **Secure Local API**: Use per-launch authentication, loopback binding, and trusted model verification

## Technologies

- **Embeddings**: Vector representations for speaker characteristics
- **Azure AI Search**: Enterprise search solution for semantic matching
- **Qdrant**: Open-source vector database for similarity search
- **Azure Services**: Cloud-based services for scalability
- **Foundry**: Development and deployment framework
- **Python/Jupyter**: Analysis and development environment
- **FastAPI and JavaScript**: Local interactive application and microphone workflow

## Project Structure

| Path | Purpose |
| --- | --- |
| [`Audio Search human voices.ipynb`](Audio%20Search%20human%20voices.ipynb) | Azure AI Search notebook |
| [`Audio Search human voices local.ipynb`](Audio%20Search%20human%20voices%20local.ipynb) | Local Qdrant notebook |
| [`webapp/`](webapp/) | Interactive FastAPI speaker-identification application |
| [`voices/`](voices/) | Reference audio used by the original notebook workflows |

## Use Cases

- **Speaker Verification**: Verify if a voice sample belongs to an enrolled speaker
- **Speaker Recognition**: Identify which speaker is present in audio
- **Voice Authentication**: Use speaker characteristics for authentication
- **Audio Analysis**: Analyze and classify audio based on speaker identity

## Getting Started

### Interactive web application

The application is in [`webapp/`](webapp/). Its complete installation, security, architecture, operation, and testing documentation is in the [web application README](webapp/README.md).

On Windows with Python 3.11 and PowerShell:

```powershell
cd webapp
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu --no-deps torch==2.6.0+cpu torchaudio==2.6.0+cpu
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe prepare_assets.py
.\start.ps1
```

Keep the trusted `voices embeddings.zip` source archive in `webapp/` for initial asset preparation. Open the complete private URL printed by `start.ps1`; each launch generates a new access token. Local Qdrant mode does not require Docker, Azure, or a separate database service.

### Notebook prerequisites

- Python 3.8+
- Jupyter Notebook
- Azure account (for Azure AI Search)
- Qdrant (for vector database if you do not want to use Azure AI Search)
- Audio processing libraries

### Notebook installation

1. Clone the repository:
```bash
git clone https://github.com/retkowsky/speaker-identification.git
cd speaker-identification
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Configure your environment:
   - Set up Azure credentials for Azure AI Search
   - Configure Qdrant connection (if using)

### Notebook usage

Open and run the Jupyter notebooks in this repository to:
- Process audio files
- Generate speaker embeddings
- Index embeddings in Azure AI Search or Qdrant
- Perform speaker identification tasks

#### Notebooks

- [Audio Search human voices.ipynb](Audio%20Search%20human%20voices.ipynb) - Main notebook for audio search with Azure AI Search
- [Audio Search human voices local.ipynb](Audio%20Search%20human%20voices%20local.ipynb) - Local implementation for audio search with Qdrant

## Architecture

The solution follows this workflow:

1. **Audio Input**: Load audio files or streams
2. **Feature Extraction**: Extract speaker characteristics
3. **Embedding Generation**: Convert features to embeddings
4. **Vector Indexing**: Store embeddings in Azure AI Search or Qdrant
5. **Similarity Search**: Query for matching speakers
6. **Speaker Identification**: Return identified speaker

## Vector Databases

### Azure AI Search
- Enterprise-grade search solution
- Scalable vector search capabilities
- Integration with Azure services

### Qdrant
- Open-source vector database
- Fast similarity search
- Docker deployment option

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

## License

This project is provided as-is. Please check the repository for license information.

## Support

For issues, questions, or suggestions, please open an issue on the GitHub repository.

## Author

| Field | Details |
| --- | --- |
| Name | Serge Retkowsky |
| Created | September 4, 2026 |
| Last updated | October 12, 2026 |
| Email | serge.retkowsky@microsoft.com |
| LinkedIn | https://www.linkedin.com/in/serger/ |
| Medium publications | https://medium.com/@sergems18/ |
