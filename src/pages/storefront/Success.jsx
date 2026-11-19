import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Footer } from '../../components/storefront/Footer'
import { CheckCircle, Package, ArrowLeft, Clock, XCircle } from 'lucide-react'

// Buyer-facing copy for orders held for fraud screening. `null` means the
// order was not held, and the original confirmation is shown.
const ORDER_STATUS_COPY = {
  processing: {
    title: 'Processing your order',
    body: 'Your payment was authorized and we are finishing your order. This page updates automatically.',
  },
  confirmed: {
    title: 'Order confirmed!',
    body: 'Thank you for your purchase. You should receive a confirmation email shortly.',
  },
  received: {
    title: 'Order received',
    body: 'Thank you. Your order is being reviewed before it ships. Your card has been authorized but not charged yet; we will email you once it is confirmed.',
  },
  declined: {
    title: 'We could not complete your order',
    body: 'Your card was not charged and the authorization has been released. Please contact us if you have questions.',
  },
}

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 15

export function Success() {
  const [searchParams] = useSearchParams()
  const [sessionData, setSessionData] = useState(null)
  const [loading, setLoading] = useState(true)
  const sessionId = searchParams.get('session_id')

  useEffect(() => {
    if (sessionId) {
      fetchSessionData()
    } else {
      setLoading(false)
    }
  }, [sessionId])

  // A held order is evaluated from the Stripe webhook, which can arrive
  // after the buyer lands here. Poll briefly until it settles.
  useEffect(() => {
    if (!sessionId || sessionData?.order_status !== 'processing') return undefined
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      try {
        const response = await fetch(`/api/checkout-session/${sessionId}`)
        if (response.ok) {
          const data = await response.json()
          setSessionData(data)
          if (data.order_status !== 'processing') clearInterval(timer)
        }
      } catch {
        // keep polling until the limit
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [sessionId, sessionData?.order_status])

  const fetchSessionData = async () => {
    try {
      const response = await fetch(`/api/checkout-session/${sessionId}`)
      if (response.ok) {
        const data = await response.json()
        setSessionData(data)
      }
    } catch (error) {
      console.error('Error fetching session data:', error)
    } finally {
      setLoading(false)
    }
  }

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

  const statusCopy = sessionData?.order_status ? ORDER_STATUS_COPY[sessionData.order_status] : null

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-full max-w-md mx-4 bg-white rounded-lg shadow-md border border-slate-200 p-8 text-center">
            {statusCopy ? (
              <>
                {sessionData.order_status === 'declined' && <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />}
                {['processing', 'received'].includes(sessionData.order_status) && <Clock className="w-16 h-16 text-amber-500 mx-auto mb-4" />}
                {sessionData.order_status === 'confirmed' && <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />}
                <h1 className="text-2xl font-bold text-slate-900 mb-2">{statusCopy.title}</h1>
                <p className="text-slate-600 mb-6" role="status" aria-live="polite">{statusCopy.body}</p>
              </>
            ) : (
              <>
                <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <h1 className="text-2xl font-bold text-slate-900 mb-2">Order Successful!</h1>
                <p className="text-slate-600 mb-6">
                  Thank you for your purchase. You should receive a confirmation email shortly.
                </p>
              </>
            )}

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
