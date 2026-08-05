import {
  createProjectForm,
  createProjectInput,
  createVideoWorkbenchActionForm,
  createVideoWorkbenchActionInput,
  type VideoWorkbenchFormField,
  type VideoWorkbenchFormResult,
  type VideoWorkbenchFormSpec,
  type VideoWorkbenchFormValues,
} from './inputForms.js'
import type {
  VideoWorkbenchActionInputProvider,
} from './product.js'
import { installVideoWorkbenchStyles } from './styles.js'

type DialogWindow = Pick<Window, 'document'>

function formElement<Tag extends keyof HTMLElementTagNameMap>(document_: Document, tag: Tag, className?: string): HTMLElementTagNameMap[Tag] {
  const element = document_.createElement(tag)
  if (className) element.className = className
  return element
}

function controlId(index: number): string {
  return `bb-video-form-${index}`
}

function setDefault(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: VideoWorkbenchFormField): void {
  if (field.kind === 'checkbox') {
    ;(control as HTMLInputElement).checked = field.defaultValue === true
    return
  }
  if (field.kind === 'select' && Array.isArray(field.defaultValue)) {
    for (const option of [...(control as HTMLSelectElement).options]) option.selected = field.defaultValue.includes(option.value)
    return
  }
  if (typeof field.defaultValue === 'string' || typeof field.defaultValue === 'number') control.value = String(field.defaultValue)
}

function appendField(document_: Document, form: HTMLFormElement, field: VideoWorkbenchFormField, index: number): void {
  const row = formElement(document_, 'label', 'bb-video-form-field')
  const id = controlId(index)
  const title = formElement(document_, 'span', 'bb-video-form-label')
  title.textContent = field.label
  row.append(title)
  if (field.kind === 'choices') {
    const choices = formElement(document_, 'span', 'bb-video-form-choices')
    const defaults = Array.isArray(field.defaultValue) ? field.defaultValue : []
    for (const option of field.options ?? []) {
      const choice = formElement(document_, 'label', 'bb-video-form-choice')
      const input = formElement(document_, 'input')
      input.type = 'checkbox'
      input.name = field.name
      input.value = option.value
      input.disabled = Boolean(option.disabled)
      input.checked = defaults.includes(option.value)
      choice.append(input)
      const label = formElement(document_, 'span')
      label.textContent = option.label
      choice.append(label)
      choices.append(choice)
    }
    row.append(choices)
  } else if (field.kind === 'textarea') {
    const control = formElement(document_, 'textarea', 'bb-video-form-control')
    control.id = id
    control.name = field.name
    control.required = Boolean(field.required)
    control.placeholder = field.placeholder ?? ''
    setDefault(control, field)
    row.htmlFor = id
    row.append(control)
  } else if (field.kind === 'select') {
    const control = formElement(document_, 'select', 'bb-video-form-control')
    control.id = id
    control.name = field.name
    control.required = Boolean(field.required)
    const placeholder = formElement(document_, 'option')
    placeholder.value = ''
    placeholder.textContent = '请选择'
    placeholder.disabled = true
    placeholder.selected = field.defaultValue === undefined
    control.append(placeholder)
    for (const option of field.options ?? []) {
      const item = formElement(document_, 'option')
      item.value = option.value
      item.textContent = option.label
      item.disabled = Boolean(option.disabled)
      control.append(item)
    }
    setDefault(control, field)
    row.htmlFor = id
    row.append(control)
  } else {
    const control = formElement(document_, 'input', field.kind === 'checkbox' ? 'bb-video-form-checkbox' : 'bb-video-form-control')
    control.id = id
    control.name = field.name
    control.type = field.kind === 'checkbox' ? 'checkbox' : field.kind
    control.required = Boolean(field.required && field.kind !== 'checkbox')
    control.placeholder = field.placeholder ?? ''
    if (field.kind === 'number') {
      if (field.min !== undefined) control.min = String(field.min)
      if (field.max !== undefined) control.max = String(field.max)
      if (field.step !== undefined) control.step = String(field.step)
    }
    setDefault(control, field)
    row.htmlFor = id
    if (field.kind === 'checkbox') {
      const inline = formElement(document_, 'span', 'bb-video-form-check-label')
      inline.textContent = field.label
      row.replaceChildren(control, inline)
    } else {
      row.append(control)
    }
  }
  if (field.help) {
    const help = formElement(document_, 'span', 'bb-video-form-help')
    help.textContent = field.help
    row.append(help)
  }
  form.append(row)
}

function readValues(form: HTMLFormElement): VideoWorkbenchFormValues {
  const values: Record<string, string | boolean | readonly string[] | undefined> = {}
  const names = [...new Set([...form.elements].flatMap(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? [element.name] : []))]
  for (const name of names) {
    if (!name) continue
    const controls = [...form.elements].filter((element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.name === name
    ))
    if (!controls.length) continue
    if (controls.every(control => control instanceof HTMLInputElement && control.type === 'checkbox')) {
      const checkboxControls = controls as HTMLInputElement[]
      if (checkboxControls.length === 1) values[name] = checkboxControls[0]!.checked
      else values[name] = checkboxControls.filter(control => control.checked).map(control => control.value)
      continue
    }
    const control = controls[0]!
    values[name] = control instanceof HTMLSelectElement && control.multiple
      ? [...control.selectedOptions].map(option => option.value)
      : control.value
  }
  return values
}

function openForm<Value>(
  window_: DialogWindow,
  spec: VideoWorkbenchFormSpec,
  submit: (values: VideoWorkbenchFormValues) => VideoWorkbenchFormResult<Value>,
): Promise<Value | undefined> {
  const document_ = window_.document
  installVideoWorkbenchStyles(document_)
  return new Promise(resolve => {
    const dialog = formElement(document_, 'dialog', 'bb-video-form-dialog')
    const form = formElement(document_, 'form', 'bb-video-form')
    form.method = 'dialog'
    const header = formElement(document_, 'header', 'bb-video-form-header')
    const title = formElement(document_, 'h2')
    title.textContent = spec.title
    header.append(title)
    if (spec.description) {
      const description = formElement(document_, 'p')
      description.textContent = spec.description
      header.append(description)
    }
    form.append(header)
    spec.fields.forEach((field, index) => appendField(document_, form, field, index))
    const error = formElement(document_, 'p', 'bb-video-form-error')
    error.setAttribute('role', 'alert')
    form.append(error)
    const actions = formElement(document_, 'footer', 'bb-video-form-actions')
    const cancel = formElement(document_, 'button', 'bb-video-action')
    cancel.type = 'button'
    cancel.textContent = '取消'
    const confirm = formElement(document_, 'button', `bb-video-action ${spec.destructive ? 'is-danger' : ''}`)
    confirm.type = 'submit'
    confirm.textContent = spec.confirmLabel
    actions.append(cancel, confirm)
    form.append(actions)
    dialog.append(form)
    document_.body.append(dialog)

    let settled = false
    let answer: Value | undefined
    const finish = (value: Value | undefined) => {
      if (settled) return
      settled = true
      dialog.removeEventListener('close', onClose)
      dialog.remove()
      resolve(value)
    }
    const onClose = () => finish(answer)
    dialog.addEventListener('close', onClose)
    cancel.addEventListener('click', () => {
      answer = undefined
      dialog.close()
    })
    dialog.addEventListener('cancel', event => {
      event.preventDefault()
      answer = undefined
      dialog.close()
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      const result = submit(readValues(form))
      if (!result.ok) {
        error.textContent = result.message
        return
      }
      answer = result.value
      dialog.close()
    })
    dialog.showModal()
    const focusTarget = form.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, button')
    focusTarget?.focus()
  })
}

/**
 * Native DOM dialogs supply structured, typed input without a second workbench
 * state store. They never request or retain filesystem paths, opaque grants,
 * endpoints, credentials, receipts, or arbitrary JSON.
 */
export function createDesktopVideoWorkbenchInputs(window_: DialogWindow = window): VideoWorkbenchActionInputProvider {
  return {
    async requestProject() {
      return await openForm(window_, createProjectForm(), createProjectInput)
    },
    async requestAction(request) {
      const form = createVideoWorkbenchActionForm(request)
      return form ? await openForm(window_, form, values => createVideoWorkbenchActionInput(request, values)) : undefined
    },
  }
}
