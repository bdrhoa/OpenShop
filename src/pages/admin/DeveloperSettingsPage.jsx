import { useEffect, useState } from 'react'
import { adminApiRequest, clearMustChangePassword } from '../../lib/auth'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { AdminPageHeader } from '../../components/admin/AdminPageHeader'

/**
 * Developer settings — API keys and runtime options, editable without a
 * terminal.
 *
 * Secret values are write-only: the API reports whether a key is set and
 * where it came from, never the value itself. Clearing a field removes the
 * override and falls back to the Worker binding.
 */
export function DeveloperSettingsPage() {
  const [fields, setFields] = useState(null)
  const [fraud, setFraud] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const [modelOptions, setModelOptions] = useState(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwStatus, setPwStatus] = useState(null)
  const [pwSaving, setPwSaving] = useState(false)

  async function load() {
    const data = await adminApiRequest('/api/admin/developer-settings')
    const body = await data.json()
    setFields(body.fields)
    setFraud(body.fraud || null)
  }

  useEffect(() => {
    load().catch((err) => setStatus({ error: err.message }))
    adminApiRequest('/api/admin/developer-settings/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Request failed (${res.status})`))))
      .then(setModelOptions)
      .catch(() => {
        // Listing unavailable — the two model fields fall back to text inputs.
        setModelOptions({ imageModels: [], textModels: [] })
      })
  }, [])

  async function save() {
    setSaving(true)
    setStatus(null)
    try {
      const res = await adminApiRequest('/api/admin/developer-settings', {
        method: 'PUT',
        body: JSON.stringify(drafts),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Could not save settings')
      setFields(body.fields)
      setFraud(body.fraud || null)
      setDrafts({})
      setStatus({ ok: 'Saved. Changes take effect immediately.' })
    } catch (err) {
      setStatus({ error: err.message })
    } finally {
      setSaving(false)
    }
  }

  async function changePassword(e) {
    e.preventDefault()
    setPwSaving(true)
    setPwStatus(null)
    try {
      const res = await adminApiRequest('/api/admin/developer-settings/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Could not change password')
      }
      setCurrentPassword('')
      setNewPassword('')
      clearMustChangePassword()
      setPwStatus({ ok: 'Password changed. Sign in again with the new password.' })
      await load()
    } catch (err) {
      setPwStatus({ error: err.message })
    } finally {
      setPwSaving(false)
    }
  }

  if (!fields) {
    return (
      <section className="admin-section">
        <AdminPageHeader title="Developer settings" />
        <p className="mt-2 text-sm text-[var(--os-color-text-secondary)]" aria-busy="true">Loading…</p>
      </section>
    )
  }

  const editable = fields.filter((f) => !f.isPassword && f.group !== 'kount')
  const kountFields = fields.filter((f) => f.group === 'kount')

  const MODEL_LISTS = {
    OPENROUTER_IMAGE_MODEL: { list: 'imageModels', current: 'currentImageModel' },
    OPENROUTER_MODEL: { list: 'textModels', current: 'currentTextModel' },
  }

  const renderModelSelect = (field, keys) => {
    const models = modelOptions?.[keys.list] || []
    const value = drafts[field.key] ?? field.value ?? ''
    const listed = models.some((m) => m.id === value)

    return (
      <select
        id={`ds-${field.key}`}
        value={value}
        onChange={(e) => setDrafts({ ...drafts, [field.key]: e.target.value })}
        className="admin-select mt-1 w-full"
      >
        <option value="">Not set (use environment default)</option>
        {!listed && value && (
          <option value={value}>{value} (saved override)</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    )
  }

  const renderField = (field) => {
          const modelKeys = modelOptions ? MODEL_LISTS[field.key] : undefined
          const useSelect = Boolean(modelKeys) && (
            (modelOptions?.[modelKeys.list] || []).length > 0 ||
            Boolean(modelOptions?.[modelKeys.current])
          )

          return (
          <div key={field.key}>
            <label
              htmlFor={`ds-${field.key}`}
              className="block text-sm font-medium text-[var(--os-color-text)]"
            >
              {field.label}
            </label>
            {useSelect ? renderModelSelect(field, modelKeys) : field.multiline ? (
            <Textarea
              id={`ds-${field.key}`}
              rows={5}
              autoComplete="off"
              spellCheck={false}
              value={drafts[field.key] ?? field.value ?? ''}
              placeholder="Not set"
              onChange={(e) => setDrafts({ ...drafts, [field.key]: e.target.value })}
              className="mt-1 font-mono text-xs"
            />
            ) : (
            <Input
              id={`ds-${field.key}`}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={drafts[field.key] ?? (field.secret ? '' : field.value ?? '')}
              placeholder={
                field.secret
                  ? (field.configured ? '•••••••• (set — type to replace)' : 'Not set')
                  : 'Not set'
              }
              onChange={(e) => setDrafts({ ...drafts, [field.key]: e.target.value })}
              className="mt-1"
            />
            )}
            <p className="mt-1 text-xs text-[var(--admin-text-muted)]">
              {field.source === 'settings' && 'Set here.'}
              {field.source === 'environment' && 'Currently from the Worker environment.'}
              {field.source === 'unset' && 'Not configured.'}
            </p>
          </div>
          )
  }

  return (
    <section className="admin-section max-w-2xl space-y-5">
      <AdminPageHeader
        title="Developer settings"
        description="API keys and runtime options. Values saved here take effect immediately and override the Worker environment. Clear a field to go back to the environment value."
      />

      <div className="mt-5 space-y-4">
        {editable.map(renderField)}
      </div>

      <h3 className="mt-8 text-lg font-semibold text-[var(--admin-text-primary)]">Fraud screening (Kount)</h3>
      <p className="mt-1.5 text-sm text-[var(--admin-text-secondary)]">
        Kount Payments Fraud. When the client ID and API key are set, card
        payments are authorized but captured only after Kount evaluates the order.
        Each setting can also come from the Worker environment variable of the same name.
      </p>
      {fraud?.kount?.error && (
        <p role="alert" className="mt-2 text-sm text-[var(--admin-error)]">Configuration error: {fraud.kount.error}</p>
      )}
      {fraud?.kount && !fraud.kount.error && (
        <p className="mt-2 text-xs text-[var(--admin-text-muted)]">
          Status: {fraud.kount.enabled ? 'screening on' : 'screening off (client ID and API key required)'}
          {' · '}{fraud.kount.environment} ({fraud.kount.apiBaseUrl})
          {' · '}effective retries {fraud.kount.maxRetries}
          {' · '}fallback {fraud.kount.fallbackDecision}
          {' · '}device collection {fraud.kount.ddcEnvironment}
          {fraud.kount.webhookKeyFingerprint ? ` · webhook key ${fraud.kount.webhookKeyFingerprint}` : ' · webhook key not set'}
        </p>
      )}

      <div className="mt-4 space-y-3 rounded-md border border-[var(--admin-border-primary)] p-3">
        <ReadOnlyUrl
          id="ds-kount-webhook-url"
          label="Kount webhook URL (register in the Kount portal)"
          value={fraud?.webhooks?.kount}
        />
        <ReadOnlyUrl
          id="ds-stripe-webhook-url"
          label="Stripe webhook URL (register in the Stripe dashboard)"
          value={fraud?.webhooks?.stripe}
        />
        {fraud?.webhooks?.stripeEvents && (
          <p className="text-xs text-[var(--admin-text-muted)]">
            Stripe events to send: {fraud.webhooks.stripeEvents.join(', ')}
          </p>
        )}
        <p className="text-xs text-[var(--admin-text-muted)]">
          Recovery job: {fraud?.recovery?.at
            ? `last ran ${new Date(fraud.recovery.at).toLocaleString()} (${fraud.recovery.pendingOrders} pending orders, ${fraud.recovery.deferredWaiting} deferred events, ${fraud.recovery.errors} errors)`
            : 'has not run yet'}
        </p>
      </div>

      <div className="mt-4 space-y-4">
        {kountFields.map(renderField)}
      </div>

      {status?.error && (
        <p role="alert" className="mt-4 text-sm text-[var(--admin-error)]">{status.error}</p>
      )}
      {status?.ok && (
        <p role="status" className="mt-4 text-sm text-[var(--admin-text-secondary)]">{status.ok}</p>
      )}

      <div className="mt-5">
        <Button onClick={save} disabled={saving || Object.keys(drafts).length === 0}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>

      <hr className="my-8 border-[var(--admin-border-primary)]" />

      <h3 className="text-lg font-semibold text-[var(--admin-text-primary)]">Admin password</h3>
      <p className="mt-1.5 text-sm text-[var(--admin-text-secondary)]">
        Changing this signs out every admin session immediately. The current
        password is required, so an unattended session cannot be used to take
        the store over.
      </p>

      <form className="mt-4 space-y-4" onSubmit={changePassword}>
        <div>
          <label htmlFor="ds-current-pw" className="block text-sm font-medium text-[var(--admin-text-primary)]">
            Current password
          </label>
          <Input
            id="ds-current-pw"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="ds-new-pw" className="block text-sm font-medium text-[var(--admin-text-primary)]">
            New password
          </label>
          <Input
            id="ds-new-pw"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-[var(--admin-text-muted)]">At least 8 characters.</p>
        </div>

        {pwStatus?.error && (
          <p role="alert" className="text-sm text-[var(--admin-error)]">{pwStatus.error}</p>
        )}
        {pwStatus?.ok && (
          <p role="status" className="text-sm text-[var(--admin-text-secondary)]">{pwStatus.ok}</p>
        )}

        <Button type="submit" disabled={pwSaving || !currentPassword || !newPassword}>
          {pwSaving ? 'Changing…' : 'Change password'}
        </Button>
      </form>
    </section>
  )
}

function ReadOnlyUrl({ id, label, value }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-[var(--admin-text-primary)]">{label}</label>
      <Input
        id={id}
        readOnly
        value={value || 'Set Site URL to see this address'}
        onFocus={(e) => e.target.select()}
        className="mt-1 font-mono text-xs"
      />
    </div>
  )
}
