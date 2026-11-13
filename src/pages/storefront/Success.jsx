import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Footer } from '../../components/storefront/Footer'
import { CheckCircle, Clock, Package, ArrowLeft, XCircle } from 'lucide-react'

// When fraud screening is on, Stripe sends the buyer here right after the
// card is authorized, before the order is approved. Poll until the order
// settles, then stop and show a "still processing" message.
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 30000

export function Success() {
  const [searchParams] = useSearchParams()
  const [sessionData, setSessionData] = useState(null)
  const [loading, setLoading] = useState(true)
  const sessionId = searchParams.get('session_id')

  useEffect(() => {
    if (!sessionId) {
      setLoading(false)
      return
    }

    let cancelled = false
    let timer
    const startedAt = Date.now()

    const poll = async () => {
      let data = null
      try {
        const response = await fetch(`/api/checkout-session/${sessionId}`)
        if (response.ok) data = await response.json()
      } catch (error) {
        console.error('Error fetching session data:', error)
      }
      if (cancelled) return

      const waiting = data?.order_status === 'processing' && Date.now() - startedAt < POLL_TIMEOUT_MS
      if (waiting) {
        timer = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }
      setSessionData(data)
      setLoading(false)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-slate-600">Processing your order...</p>
        </div>
      </div>
    )
  }

  if (!sessionId) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-full max-w-md bg-white rounded-lg shadow-md border border-slate-200 p-8 text-center">
          <Package className="w-16 h-16 text-slate-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Order not found</h1>
          <p className="text-slate-600 mb-6">
            We couldn't find your order information. If you just checked out, check your email for confirmation.
          </p>
          <Link to="/">
            <Button>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Store
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  const views = {
    confirmed: {
      icon: <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />,
      title: 'Order Successful!',
      body: 'Thank you for your purchase. You should receive a confirmation email shortly.',
    },
    processing: {
      icon: <Clock className="w-16 h-16 text-amber-500 mx-auto mb-4" />,
      title: 'Order received',
      body: "We're still finalizing your order. We'll email you once it's confirmed.",
    },
    declined: {
      icon: <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />,
      title: "We couldn't complete your order",
      body: 'Your order was not placed. Any charge or pending authorization on your card will be reversed.',
    },
  }
  // If the status can't be loaded, don't claim success.
  const view = sessionData
    ? views[sessionData.order_status] || views.confirmed
    : views.processing

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-full max-w-md mx-4 bg-white rounded-lg shadow-md border border-slate-200 p-8 text-center">
            {view.icon}
            <h1 className="text-2xl font-bold text-slate-900 mb-2">{view.title}</h1>
            <p className="text-slate-600 mb-6">{view.body}</p>

            {sessionData && (
              <div className="bg-slate-50 rounded-lg p-4 mb-6">
                <p className="text-sm text-slate-600">Order ID</p>
                <p className="font-mono text-sm">{sessionData.id}</p>
              </div>
            )}

            <div className="space-y-3">
              <Link to="/" className="block">
                <Button className="w-full">
                  Continue Shopping
                </Button>
              </Link>
            </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-auto">
        <Footer />
      </div>
    </div>
  )
}
