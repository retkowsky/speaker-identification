# Contributing to Speaker Identification

Thank you for your interest in contributing to the Speaker Identification project! We welcome contributions from the community to help improve this project.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/your-username/speaker-identification.git
   cd speaker-identification
   ```
3. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```
4. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

## Development Workflow

### Creating a Feature Branch

Create a descriptive branch name for your changes:
```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### Working with Jupyter Notebooks

Since this project uses Jupyter Notebooks:

- Keep notebooks organized and well-documented
- Use clear cell separations and markdown comments to explain your work
- Test your notebook cells to ensure they run without errors
- Clear output before committing to keep repository size manageable:
  ```bash
  jupyter nbconvert --ClearOutputPreprocessor.enabled=True --inplace your-notebook.ipynb
  ```

### Code Style and Best Practices

- Follow [PEP 8](https://www.python.org/dev/peps/pep-0008/) style guidelines
- Use descriptive variable and function names
- Add docstrings to functions and classes
- Include comments for complex logic
- Use type hints where applicable

### Testing

- Test your changes thoroughly before submitting a pull request
- Verify that existing notebooks still run correctly
- Document any new dependencies added

## Submitting Changes

### Commit Messages

Write clear, descriptive commit messages:
- Use the imperative mood ("Add feature" not "Added feature")
- Keep the first line under 50 characters
- Provide additional context in the message body if needed

Example:
```
Add speaker embedding extraction functionality

Implement new module for extracting embeddings from audio files
using the pre-trained model. Includes support for batch processing
and integration with Azure AI Search.
```

### Pull Request Process

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub with:
   - A clear title describing your changes
   - A detailed description of what was changed and why
   - Reference any related issues (e.g., "Fixes #123")
   - Screenshots or examples if applicable

3. **Address feedback** from reviewers
   - Be responsive and open to suggestions
   - Push additional commits to address review comments
   - Maintain a clean commit history

4. **Wait for approval** before your PR is merged

## Areas for Contribution

We welcome contributions in the following areas:

- **Bug fixes**: Report and fix issues in existing code
- **New features**: Implement new speaker identification capabilities
- **Documentation**: Improve notebooks, comments, and README
- **Examples**: Add new use cases or examples
- **Performance**: Optimize existing code or embeddings
- **Integration**: Add support for new vector databases or AI services
- **Tests**: Improve test coverage and reliability

## Integration with Azure AI Search and Qdrant

If your contribution involves:
- **Azure AI Search**: Ensure compatibility with the latest SDK
- **Qdrant**: Test with both local and cloud deployments
- **Embeddings**: Verify compatibility with supported models

## Reporting Issues

Found a bug? Please open an issue with:
- A clear description of the problem
- Steps to reproduce the issue
- Expected vs. actual behavior
- Your environment details (Python version, OS, etc.)
- Relevant error messages or logs

## Questions or Need Help?

- Check existing issues and pull requests
- Review the README and documentation
- Open a discussion if you have general questions

## Code of Conduct

Please be respectful and professional when interacting with the community. We are committed to providing a welcoming and inclusive environment for all contributors.

## License

By contributing to this project, you agree that your contributions will be licensed under the same license as the project (check the LICENSE file for details).

---

Thank you for making Speaker Identification better! 🎤
