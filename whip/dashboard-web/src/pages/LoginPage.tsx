import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { WhipAPIClient, buildConnectURL, parseConnectURL, AuthError, ConnectionError } from '../api/client'
import { saveAuth, clearAuth, getClient, loadAuth } from '../stores/auth'

interface Props {
  onLogin: () => void
}

export function LoginPage({ onLogin }: Props) {
  const [searchParams] = useSearchParams()
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const autoConnect = async () => {
      // Check ?url= query param for auto-connect
      const urlParam = searchParams.get('url')
      if (urlParam) {
        setUrl(urlParam)
        window.history.replaceState({}, '', window.location.pathname)
        const parsed = parseConnectURL(urlParam)
        if (parsed) {
          try {
            const c = new WhipAPIClient(parsed.baseURL, parsed.token)
            await c.getPeers()
            saveAuth(parsed)
            onLogin()
            return
          } catch {
            // Fall through to normal flow
          }
        }
      }

      const client = getClient()
      if (!client) {
        setChecking(false)
        return
      }
      try {
        await client.getPeers()
        onLogin()
      } catch (err) {
        if (err instanceof ConnectionError) {
          // Server temporarily unreachable — don't clear potentially valid credentials
          const auth = loadAuth()
          if (auth) {
            setUrl(buildConnectURL(auth.baseURL, auth.token))
          }
          setError('Cannot connect to server')
        } else {
          // AuthError or unknown — credentials are invalid
          clearAuth()
        }
        setChecking(false)
      }
    }
    autoConnect()
  }, [onLogin, searchParams])

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setError('')

    const parsed = parseConnectURL(url.trim())
    if (!parsed) {
      setError('Invalid URL format. Expected: https://...#token=... (legacy ?token=... also works)')
      return
    }

    setLoading(true)
    try {
      const client = new WhipAPIClient(parsed.baseURL, parsed.token)
      await client.getPeers()
      saveAuth(parsed)
      onLogin()
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Invalid token')
      } else {
        setError('Cannot connect to server')
      }
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <svg className="animate-spin h-6 w-6 text-[#8B5CF6]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="w-full max-w-sm p-8 rounded-xl bg-white dark:bg-[#1E293B] border border-gray-200 dark:border-slate-700 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="bg-[#8B5CF6] text-white text-xs font-bold px-2 py-0.5 rounded">whip</span>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Connect to your orchestrator</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="connect-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Connect URL
            </label>
            <input
              id="connect-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxx.trycloudflare.com#token=abc123"
              disabled={loading}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6] focus:border-transparent transition-colors disabled:opacity-60"
            />
            {error && (
              <p className="mt-1.5 text-sm text-red-500">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="w-full py-2 px-4 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Connecting...
              </>
            ) : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}
