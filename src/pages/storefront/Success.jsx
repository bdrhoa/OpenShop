import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Footer } from '../../components/storefront/Footer'
import { CheckCircle, Package, ArrowLeft, Clock, XCircle } from 'lucide-react'

// Payments screened by Kount are held until a decision is made, so the order
// may still be "processing" when the buyer lands here.
const STATUS_COPY = {
  confirmed: {
    title: 'Order Successful!',
    body: 'Thank you for your purchase. You should receive a confirmation email shortly.',
  },
  processing: {
    title: 'Order received',
    body: 'Thank you! We are confirming your payment. This usually takes a few seconds.',
  },
  received: {
    title: 'Order received',
    body: 'Thank you! Your order is being reviewed. Your card has not been charged yet; we will email you once it is confirmed.',
  },
  declined: {
    title: 'We could not complete your order',
    body: 'Your payment was not taken and the card authorization has been released. Please contact us if you think this is a mistake.',
  },
}
const MAX_POLLS = 5
const POLL_MS = 2000

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

  const fetchSessionData = async (attempt = 0) => {
    try {
      const response = await fetch(`/api/checkout-session/${sessionId}`)
      if (response.ok) {
        const data = await response.json()
        setSessionData(data)
        if (data.orderStatus === 'processing' && attempt < MAX_POLLS) {
          setTimeout(() => fetchSessionData(attempt + 1), POLL_MS)
        }
      }
    } catch (error) {
      console.error('Error fetching session data:', error)
    } finally {
      setLoading(false)
    }
  }

  const status = sessionData?.orderStatus || 'confirmed'
  const copy = STATUS_COPY[status] || STATUS_COPY.processing

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

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-full max-w-md mx-4 bg-white rounded-lg shadow-md border border-slate-200 p-8 text-center">
            {status === 'declined'
              ? <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
              : status === 'confirmed'
                ? <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                : <Clock className="w-16 h-16 text-amber-500 mx-auto mb-4" />}
            <h1 className="text-2xl font-bold text-slate-900 mb-2">{copy.title}</h1>
            <p className="text-slate-600 mb-6">{copy.body}</p>

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
