import { docker, run } from './run'

// Pre-flight checks for Docker deployment
export async function checkDockerPrerequisites() {
  const checks = {
    docker: false,
    dockerCompose: false,
    internetConnection: false,
  }

  try {
    await docker(['--version'])
    checks.docker = true
  } catch {
    // Docker not available
  }

  try {
    await docker(['compose', 'version'])
    checks.dockerCompose = true
  } catch {
    // Docker Compose not available
  }

  // Multi-layered internet connectivity check
  checks.internetConnection = await checkInternetConnectivity()

  return checks
}

// Improved internet connectivity check using multiple methods
export async function checkInternetConnectivity(): Promise<boolean> {
  // Method 1: HTTP connectivity test to multiple reliable endpoints
  const httpEndpoints = [
    'https://www.google.com',
    'https://1.1.1.1', // Cloudflare DNS
    'https://8.8.8.8', // Google DNS
  ]

  for (const endpoint of httpEndpoints) {
    try {
      // Use curl for HTTP connectivity test with short timeout
      await run('curl', ['-s', '--max-time', '10', '--head', endpoint], { timeout: 15000 })
      return true // If any endpoint succeeds, we have internet
    } catch {
      // Try next endpoint
      continue
    }
  }

  // Method 2: DNS resolution test
  try {
    await run('nslookup', ['google.com'], { timeout: 10000 })
    return true
  } catch {
    // DNS resolution failed
  }

  // Method 3: Ping test (as fallback)
  try {
    const pingArgs = process.platform === 'win32'
      ? ['-n', '1', '8.8.8.8']
      : ['-c', '1', '8.8.8.8']
    await run('ping', pingArgs, { timeout: 10000 })
    return true
  } catch {
    // Ping failed
  }

  // Method 4: Docker registry connectivity (original method as last resort)
  try {
    await docker(['pull', 'alpine:latest'], {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for Docker pull
    })
    return true
  } catch {
    // All methods failed
  }

  return false
}
