import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Footer } from '../../components/storefront/Footer'
import { CheckCircle, Clock, Package, ArrowLeft, XCircle } from 'lucide-react'
import { rotateKountSessionAfterOrder } from '../../lib/kountDdc'

// A held payment settles when the Stripe webhook arrives, usually within seconds.
const ORDER_POLL_INTERVAL_MS = 2000
const ORDER_POLL_ATTEMPTS = 15

const ORDER_MESSAGES = {
  pending: {
    Icon: Clock,
    iconClass: 'text-amber-500',
    title: 'Finishing your order',
    body: 'We are confirming your payment. Your card has not been charged yet.',
  },
  on_hold: {
    Icon: Clock,
    iconClass: 'text-amber-500',
    title: 'Your order is being reviewed',
    body: 'Your payment went through, and your order is on hold while we review it. It will ship once the review is complete.',
  },
  refunded: {
    Icon: XCircle,
    iconClass: 'text-red-500',
    title: 'We could not complete your order',
    body: 'Your payment has been refunded. It can take a few business days to appear on your statement.',
  },
  declined: {
    Icon: XCircle,
    iconClass: 'text-red-500',
    title: 'We could not complete your order',
    body: 'Your card was not charged. Any hold on your card will be released by your bank.',
  },
  confirmed: {
    Icon: CheckCircle,
    iconClass: 'text-green-500',
    title: 'Order Successful!',
    body: 'Thank you for your purchase. You should receive a confirmation email shortly.',
  },
}

export function Success() {
  const [searchParams] = useSearchParams()
  const [sessionData, setSessionData] = useState(null)
  const [loading, setLoading] = useState(true)
  const sessionId = searchParams.get('session_id')

  useEffect(() => {
    if (!sessionId) {
      setLoading(false)
      return undefined
    }

    let stopped = false
    let timer
    let attempts = 0

    const fetchSessionData = async () => {
      try {
        const response = await fetch(`/api/checkout-session/${sessionId}`)
        if (response.ok && !stopped) {
          const data = await response.json()
          setSessionData(data)
          // The order has used this session ID once checkout completes, whatever
          // Kount decides, so the next order must not reuse it.
          if (data.status === 'complete' || data.payment_status === 'paid') {
            rotateKountSessionAfterOrder(data.kount_session_id)
          }
          if (data.order_status === 'pending' && attempts < ORDER_POLL_ATTEMPTS) {
            attempts += 1
            timer = setTimeout(fetchSessionData, ORDER_POLL_INTERVAL_MS)
          }
        }
      } catch (error) {
        console.error('Error fetching session data:', error)
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    fetchSessionData()
    return () => {
      stopped = true
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

  const { Icon, iconClass, title, body } = ORDER_MESSAGES[sessionData?.order_status] ?? ORDER_MESSAGES.confirmed

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-full max-w-md mx-4 bg-white rounded-lg shadow-md border border-slate-200 p-8 text-center">
            <Icon className={`w-16 h-16 ${iconClass} mx-auto mb-4`} />
            <h1 className="text-2xl font-bold text-slate-900 mb-2">{title}</h1>
            <p className="text-slate-600 mb-6">{body}</p>

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
