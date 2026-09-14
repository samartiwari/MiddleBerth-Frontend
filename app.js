'use strict';

(function () {
  const API = window.MIDDLEBERTH.api;
  const CLASSES = ['3A', 'SL'];
  const CLASS_NAMES = { '3A': 'AC 3 Tier', SL: 'Sleeper' };
  // Shown before booking only. The amount actually charged comes from the server.
  const FARES = { '3A': 2400, SL: 900 };
  const FEE_BPS = 300;
  const FINAL = ['REGRETTED', 'EXPIRED', 'CANCELLED'];

  const $ = (selector, root = document) => root.querySelector(selector);

  /** Builds elements from plain text only, so nothing the API returns is ever parsed as HTML. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // Kept for this tab only: closing it signs the visitor out.
  const store = {
    get(key) {
      try { return JSON.parse(sessionStorage.getItem('middleberth.' + key)); } catch (e) { return null; }
    },
    set(key, value) {
      try {
        if (value === null) sessionStorage.removeItem('middleberth.' + key);
        else sessionStorage.setItem('middleberth.' + key, JSON.stringify(value));
      } catch (e) { /* storage unavailable: the page still works, it just forgets on reload */ }
    }
  };

  const state = {
    auth: store.get('auth'),
    trains: [],
    dates: [],
    date: null,
    availability: [],
    choice: null,
    booking: store.get('booking'),
    pollTimer: null,
    countdownTimer: null
  };

  // ---------- talking to the API, and showing every call ----------

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || 'HTTP ' + status);
      this.status = status;
      this.code = code;
    }
  }

  async function call(method, path, { body, auth = false, note, quiet = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!signedIn()) throw new ApiError(401, 'SIGNED_OUT', 'Sign in first.');
      headers.Authorization = 'Bearer ' + state.auth.token;
    }
    const started = performance.now();
    let response;
    try {
      response = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (!quiet) log(method, path, 'ERR', performance.now() - started, 'the API could not be reached');
      throw new ApiError(0, 'NETWORK', 'Could not reach the MiddleBerth API. Try again in a moment.');
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!quiet) {
      const explained = typeof note === 'function' ? note(response.status, data) : note;
      log(method, path, response.status, performance.now() - started, response.ok ? explained : errorNote(data));
    }
    if (response.status === 401 && auth) signOut('Your session ended. Log in again to carry on.');
    if (!response.ok) throw new ApiError(response.status, data && data.code, data && (data.message || data.error));
    return data;
  }

  function errorNote(data) {
    if (!data) return null;
    return [data.code, data.message || data.error].filter(Boolean).join(': ');
  }

  function log(method, path, status, ms, note) {
    const list = $('#console-lines');
    const empty = $('#console-empty');
    if (empty) empty.remove();
    const kind = typeof status !== 'number' ? (status === 'ERR' ? 's-err' : 's-info')
      : status >= 500 ? 's-err' : status >= 400 ? 's-warn' : 's-ok';
    list.prepend(el('li', { class: 'line' },
      el('div', { class: 'line-top' },
        el('span', { class: 'method' }, method),
        el('span', { class: 'path', title: path }, path),
        el('span', { class: 'status ' + kind }, String(status)),
        el('span', { class: 'ms' }, ms === null ? '' : Math.max(1, Math.round(ms)) + ' ms')),
      note ? el('div', { class: 'note' }, note) : null));
    while (list.children.length > 60) list.lastElementChild.remove();
  }

  // ---------- small helpers ----------

  const indiaDate = (offsetDays) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(Date.now() + offsetDays * 86400000));

  const niceDate = (iso) => new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata'
  });

  const rupees = (amount) => '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const fromPaise = (paise) => rupees(paise / 100);
  const totalFor = (coachClass) => FARES[coachClass] + Math.ceil(FARES[coachClass] * FEE_BPS) / 10000;

  function randomId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').toUpperCase();
  }

  function busy(button, on) {
    const node = typeof button === 'string' ? $(button) : button;
    if (!node) return;
    node.disabled = on;
    node.classList.toggle('is-busy', on);
    node.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function showError(selector, message) {
    const node = $(selector);
    if (!node) return;
    node.hidden = !message;
    node.textContent = message || '';
  }

  const signedIn = () => !!state.auth && state.auth.expiresAt > Date.now();

  // ---------- step 1: the account ----------

  let authMode = 'signup';

  function setAuthMode(mode) {
    authMode = mode;
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
    $('#auth-form').password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
    showError('#auth-error', null);
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !form.email.checkValidity()) return showError('#auth-error', 'Enter a real email address.');
    if (password.length < 8) return showError('#auth-error', 'The password needs at least 8 characters.');
    showError('#auth-error', null);
    busy('#auth-submit', true);
    try {
      const reply = await call('POST', '/auth/' + authMode, {
        body: { email, password },
        note: (status) => status === 201
          ? 'account created in the gateway\'s own database, password hashed with BCrypt'
          : 'the gateway signed a token; the services behind it never see a password'
      });
      state.auth = { token: reply.token, email, expiresAt: Date.now() + reply.expiresInSeconds * 1000 };
      store.set('auth', state.auth);
      form.reset();
      renderAuth();
      if (state.booking && !FINAL.includes(state.booking.last)) resumeBooking();
    } catch (e) {
      showError('#auth-error', authMessage(e));
    } finally {
      busy('#auth-submit', false);
    }
  }

  function authMessage(e) {
    if (e.status === 409) return 'That email already has an account. Log in instead.';
    if (e.status === 401) return 'Wrong email or password.';
    if (e.status === 429) return authMode === 'login'
      ? 'Too many wrong tries: this account is locked for 15 minutes.'
      : 'Too many sign-ups from this network. Try again later.';
    if (e.status === 400) return 'Check the email, and use a password of 8 to 100 characters.';
    return e.message;
  }

  function signOut(message, forget) {
    state.auth = null;
    store.set('auth', null);
    stopTimers();
    if (forget) {
      state.booking = null;
      store.set('booking', null);
      renderJourney(null);
    }
    renderAuth();
    if (message) showError('#auth-error', message);
  }

  function renderAuth() {
    const on = signedIn();
    if (state.auth && !on) {
      state.auth = null;
      store.set('auth', null);
    }
    $('#signed-out').hidden = on;
    $('#signed-in').hidden = !on;
    if (on) {
      $('#signed-in-email').textContent = state.auth.email;
      $('.avatar').textContent = state.auth.email.charAt(0).toUpperCase();
    }
    renderBookForm();
  }

  // ---------- step 2: trains ----------

  async function loadTrains() {
    try {
      state.trains = await call('GET', '/api/trains', { note: 'search-service: the list of trains, no login needed' });
    } catch (e) {
      $('#trains').replaceChildren(el('p', { class: 'form-error' }, e.message));
      return;
    }
    state.dates = [indiaDate(0), indiaDate(1)];
    await chooseDate(state.dates[1], true);
  }

  async function chooseDate(date, fallBackToToday) {
    state.date = date;
    renderDates();
    $('#trains').replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
    const started = performance.now();
    const pairs = state.trains.flatMap((train) => CLASSES.map((coachClass) => ({ train, coachClass })));
    const results = await Promise.all(pairs.map(({ train, coachClass }) =>
      call('GET', '/api/trains/' + encodeURIComponent(train.number) + '/availability?date=' + date + '&class=' + coachClass, { quiet: true })
        .then((a) => ({ train, coachClass, a }))
        .catch(() => ({ train, coachClass, a: { status: 'UNKNOWN' } }))));
    log('GET', '/api/trains/…/availability  ×' + pairs.length, 200, performance.now() - started,
      niceDate(date) + ': free berths per train and class, kept current by booking events and served from Redis');

    const onSale = results.some((r) => r.a.status !== 'UNKNOWN');
    if (!onSale && fallBackToToday && date !== state.dates[0]) {
      const hint = $('#date-hint');
      hint.hidden = false;
      hint.textContent = niceDate(date) + ' is not on sale yet: tatkal opens at noon the day before. Showing ' + niceDate(state.dates[0]) + ' instead.';
      return chooseDate(state.dates[0], false);
    }
    state.availability = results;
    renderTrains();
  }

  function renderDates() {
    $('#dates').replaceChildren(...state.dates.map((date, i) => el('button', {
      type: 'button',
      class: 'chip' + (date === state.date ? ' is-active' : ''),
      role: 'tab',
      'aria-selected': date === state.date ? 'true' : 'false',
      onclick: () => {
        $('#date-hint').hidden = true;
        if (date !== state.date) {
          state.choice = null;
          renderBookForm();
          chooseDate(date, false);
        }
      }
    }, el('span', { class: 'chip-label' }, i === 0 ? 'Today' : 'Tomorrow'), el('span', { class: 'chip-date' }, niceDate(date)))));
  }

  function renderTrains() {
    const byTrain = new Map();
    for (const r of state.availability) {
      if (!byTrain.has(r.train.number)) byTrain.set(r.train.number, { train: r.train, classes: [] });
      byTrain.get(r.train.number).classes.push(r);
    }
    $('#trains').replaceChildren(...Array.from(byTrain.values(), ({ train, classes }) => el('div', { class: 'train' },
      el('div', { class: 'train-id' },
        el('span', { class: 'train-no' }, train.number),
        el('span', { class: 'train-name' }, train.name)),
      el('div', { class: 'classes' }, ...classes.map(({ coachClass, a }) => classButton(train, coachClass, a))))));
  }

  function classButton(train, coachClass, a) {
    const selected = !!state.choice && state.choice.train === train.number && state.choice.coachClass === coachClass;
    const badge = a.status === 'AVAILABLE' ? el('span', { class: 'badge b-ok' }, a.freeSeats + ' free')
      : a.status === 'WAITLIST' ? el('span', { class: 'badge b-warn' }, 'Waitlist')
        : el('span', { class: 'badge b-off' }, 'Not on sale');
    return el('button', {
      type: 'button',
      class: 'class-btn' + (selected ? ' is-selected' : ''),
      disabled: a.status === 'UNKNOWN',
      'aria-pressed': selected ? 'true' : 'false',
      onclick: () => {
        state.choice = { train: train.number, name: train.name, coachClass };
        renderTrains();
        renderBookForm();
        $('#step-book').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    el('span', { class: 'class-code' }, coachClass),
    el('span', { class: 'class-name' }, CLASS_NAMES[coachClass]),
    el('span', { class: 'fare' }, rupees(FARES[coachClass])),
    badge);
  }

  // ---------- step 3: booking ----------

  function renderBookForm() {
    const choice = state.choice;
    const booking = state.booking;
    const summary = $('#book-summary');
    if (booking) {
      summary.textContent = booking.train + ' ' + booking.name + ' · ' + CLASS_NAMES[booking.coachClass] + ' · ' + niceDate(booking.date);
    } else if (!choice) {
      summary.textContent = 'Choose a train and class above.';
    } else {
      summary.textContent = choice.train + ' ' + choice.name + ' · ' + CLASS_NAMES[choice.coachClass] + ' · ' + niceDate(state.date)
        + ' · ' + rupees(FARES[choice.coachClass]) + ' plus a 3% fee' + (signedIn() ? '' : '. Create an account or log in first.');
    }
    $('#book-form').hidden = !(choice && signedIn()) || !!booking;
  }

  async function submitBooking(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const passenger = { name: form.name.value.trim(), phone: form.phone.value.trim(), email: form.email.value.trim() };
    if (!passenger.name) return showError('#book-error', 'Enter the passenger\'s name.');
    if (!/^[6-9][0-9]{9}$/.test(passenger.phone)) return showError('#book-error', 'Enter a 10 digit Indian mobile number.');
    if (!passenger.email || !form.email.checkValidity()) return showError('#book-error', 'Enter a real email address for the ticket.');
    showError('#book-error', null);

    const choice = state.choice;
    const booking = {
      requestId: 'WEB-' + randomId(),
      train: choice.train, name: choice.name, coachClass: choice.coachClass, date: state.date,
      passenger, polls: 0
    };
    state.booking = booking;
    store.set('booking', booking);
    busy('#book-submit', true);
    renderJourney({ stage: 'sending' });

    const started = performance.now();
    try {
      await call('POST', '/api/bookings', {
        auth: true,
        body: { requestId: booking.requestId, trainNumber: booking.train, travelDate: booking.date, coachClass: booking.coachClass, passenger },
        note: 'accepted: put on Kafka, keyed by train, date and class. A booking thread decides next.'
      });
      booking.acceptedMs = Math.round(performance.now() - started);
      store.set('booking', booking);
      renderBookForm();
      renderJourney({ stage: 'queued' });
      poll(500);
    } catch (e) {
      if (e.code === 'WAITLIST_FULL') {
        booking.atDoor = true;
        return settle({ status: 'REGRETTED' });
      }
      state.booking = null;
      store.set('booking', null);
      renderJourney(null);
      renderBookForm();
      showError('#book-error', bookingMessage(e));
    } finally {
      busy('#book-submit', false);
    }
  }

  function bookingMessage(e) {
    switch (e.code) {
      case 'NOT_ON_SALE': return 'That date is not on sale. Pick the other date above.';
      case 'TRAIN_NOT_FOUND': return 'That train cannot be booked on this demo server.';
      case 'INVALID_REQUEST': return 'Check the passenger details: ' + e.message;
      case 'QUEUE_UNAVAILABLE': return 'The queue did not take the request, so nothing was booked. Try again.';
      default:
        if (e.status === 429) return 'Slow down: bookings are limited to one a second per person.';
        return e.message;
    }
  }

  function describe(result) {
    switch (result.status) {
      case 'HELD': return 'berth ' + result.seat + ' locked for you with FOR UPDATE SKIP LOCKED';
      case 'WAITLIST_HELD': return 'waitlist place ' + result.position + ' held, from an atomic counter';
      case 'CONFIRMED': return 'paid and confirmed, PNR ' + result.pnr;
      case 'WAITLISTED': return 'paid, waiting at position ' + result.position + ', PNR ' + result.pnr;
      case 'REGRETTED': return 'no berth and no waitlist place left';
      case 'EXPIRED': return 'the hold ran out before it was paid for';
      case 'CANCELLED': return 'given up; the berth goes to the next person waiting';
      default: return result.status;
    }
  }

  function poll(waitMs) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      const booking = state.booking;
      if (!booking || !signedIn()) return;
      try {
        const result = await call('GET', '/api/bookings/' + encodeURIComponent(booking.requestId), {
          auth: true,
          note: (status, data) => !data ? null
            : data.status === 'PENDING' ? 'not decided yet; the server says ask again in ' + data.retryAfterMs + ' ms'
              : describe(data)
        });
        if (result.status === 'PENDING') {
          booking.polls = (booking.polls || 0) + 1;
          store.set('booking', booking);
          renderJourney({ stage: 'queued', retry: result.retryAfterMs });
          return poll(result.retryAfterMs || 1000);
        }
        // Counts the polls it took to get the first answer, not the checks after it.
        if (!booking.result) booking.polls = (booking.polls || 0) + 1;
        settle(result);
      } catch (e) {
        if (e.status === 429 || e.status === 0) return poll(1500);
        if (e.status !== 401) renderJourney({ stage: 'queued', error: e.message });
      }
    }, waitMs);
  }

  function settle(result) {
    const booking = state.booking;
    if (!booking) return;
    booking.last = result.status;
    booking.result = result;
    store.set('booking', booking);
    renderBookForm();
    renderJourney({ stage: 'decided', result });
  }

  // ---------- step 3, continued: paying and cancelling ----------

  let razorpayLoading = null;

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (!razorpayLoading) {
      razorpayLoading = new Promise((resolve, reject) => {
        document.head.append(el('script', {
          src: 'https://checkout.razorpay.com/v1/checkout.js',
          onload: resolve,
          onerror: () => { razorpayLoading = null; reject(new Error('blocked')); }
        }));
      });
    }
    return razorpayLoading;
  }

  function payStatus(message, isError) {
    const node = $('#pay-status');
    if (!node) return;
    node.hidden = !message;
    node.textContent = message || '';
    node.classList.toggle('is-error', !!isError);
  }

  async function pay(button) {
    const booking = state.booking;
    if (!booking) return;
    busy(button, true);
    payStatus('Creating a Razorpay order…');
    let order;
    try {
      order = await call('POST', '/api/bookings/' + encodeURIComponent(booking.requestId) + '/pay', {
        auth: true,
        note: (status, data) => data
          ? 'booking-service asked payment-service for a Razorpay order: ' + fromPaise(data.baseFarePaise) + ' fare + ' + fromPaise(data.convenienceFeePaise) + ' fee'
          : null
      });
    } catch (e) {
      busy(button, false);
      return payStatus(e.code === 'NOT_PAYABLE' ? 'This booking can no longer be paid for.' : e.message, true);
    }
    if (order.keyId === 'rzp_test_stub') {
      busy(button, false);
      return payStatus('Payments are simulated on this server, so there is no checkout window to open.', true);
    }
    try {
      await loadRazorpay();
    } catch (e) {
      busy(button, false);
      return payStatus('Razorpay\'s checkout did not load. An ad blocker may be blocking it.', true);
    }
    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amountPaise,
      currency: order.currency,
      order_id: order.orderId,
      name: 'MiddleBerth',
      description: booking.train + ' ' + booking.name + ' · ' + booking.coachClass + ' · ' + niceDate(booking.date),
      prefill: { name: booking.passenger.name, email: booking.passenger.email, contact: booking.passenger.phone },
      theme: { color: '#14215c' },
      handler: (reply) => {
        log('RZP', 'checkout', 'paid', null, 'payment ' + reply.razorpay_payment_id + ' captured; waiting for Razorpay\'s signed webhook to reach payment-service');
        // Remembered, so a reload keeps waiting for the confirmation instead of offering to pay again.
        booking.paidAt = Date.now();
        store.set('booking', booking);
        payStatus('Paid. Waiting for Razorpay to tell the server…');
        waitForConfirmation(booking.paidAt);
      },
      modal: {
        ondismiss: () => {
          busy(button, false);
          payStatus('Checkout closed. The berth stays held until the timer runs out.');
        }
      }
    });
    checkout.on('payment.failed', (reply) => {
      busy(button, false);
      payStatus('Payment failed: ' + ((reply.error && reply.error.description) || 'try another test card') + '.', true);
    });
    checkout.open();
  }

  function waitForConfirmation(startedAt) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      const booking = state.booking;
      if (!booking || !signedIn()) return;
      try {
        const result = await call('GET', '/api/bookings/' + encodeURIComponent(booking.requestId), {
          auth: true,
          note: (status, data) => !data ? null
            : data.status === 'CONFIRMED' || data.status === 'WAITLISTED' ? describe(data)
              : 'payment not recorded yet'
        });
        if (result.status === 'CONFIRMED' || result.status === 'WAITLISTED') return settle(result);
        if (Date.now() - startedAt > 180000) {
          return payStatus('Still waiting for Razorpay. If the payment went through, the server\'s reconciliation job will confirm it within a couple of minutes.', true);
        }
        waitForConfirmation(startedAt);
      } catch (e) {
        if (e.status === 429 || e.status === 0) return waitForConfirmation(startedAt);
        if (e.status !== 401) payStatus(e.message, true);
      }
    }, 1500);
  }

  async function cancel(button) {
    const booking = state.booking;
    if (!booking) return;
    if (button.dataset.confirm !== 'yes') {
      button.dataset.confirm = 'yes';
      button.textContent = 'Tap again to cancel';
      setTimeout(() => {
        if (button.isConnected && !button.disabled) {
          button.dataset.confirm = '';
          button.textContent = button.dataset.label;
        }
      }, 3500);
      return;
    }
    busy(button, true);
    try {
      const reply = await call('POST', '/api/bookings/' + encodeURIComponent(booking.requestId) + '/cancel', {
        auth: true,
        note: (status, data) => data
          ? 'cancelled; the berth went to the next paid waitlister in the same transaction' + (data.refundOnItsWay ? ', and a refund was requested' : '')
          : null
      });
      settle({ status: 'CANCELLED', pnr: reply.pnr, refund: reply.refundOnItsWay });
    } catch (e) {
      busy(button, false);
      payStatus(e.code === 'NOT_CANCELLABLE' ? 'This booking can no longer be cancelled.' : e.message, true);
    }
  }

  function bookAnother() {
    stopTimers();
    state.booking = null;
    state.choice = null;
    store.set('booking', null);
    renderJourney(null);
    renderBookForm();
    if (state.date) chooseDate(state.date, false);
    $('#step-train').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resumeBooking() {
    const booking = state.booking;
    if (!booking) return;
    if (booking.result) renderJourney({ stage: 'decided', result: booking.result });
    else renderJourney({ stage: 'queued' });
    if (!signedIn()) return;
    // Paid but not yet confirmed when the page was reloaded. The server may still say
    // HELD for a few seconds, so keep asking rather than taking that as the answer.
    if (booking.paidAt && (booking.last === 'HELD' || booking.last === 'WAITLIST_HELD')) {
      payStatus('Paid. Waiting for Razorpay to tell the server…');
      return waitForConfirmation(booking.paidAt);
    }
    if (!FINAL.includes(booking.last)) poll(300);
  }

  // ---------- the journey panel ----------

  function stopTimers() {
    clearTimeout(state.pollTimer);
    clearInterval(state.countdownTimer);
  }

  function startCountdown(payBy) {
    clearInterval(state.countdownTimer);
    const end = new Date(payBy).getTime();
    const tick = () => {
      const node = $('#countdown');
      if (!node) return clearInterval(state.countdownTimer);
      const left = Math.max(0, end - Date.now());
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor(left / 1000) % 60;
      node.textContent = minutes + ':' + String(seconds).padStart(2, '0');
      node.classList.toggle('urgent', left < 60000);
      if (left === 0) {
        clearInterval(state.countdownTimer);
        poll(3000);
      }
    };
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  function renderJourney(view) {
    const box = $('#journey');
    clearInterval(state.countdownTimer);
    if (!view) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const booking = state.booking;
    box.hidden = false;

    const decided = view.stage === 'decided';
    const result = view.result;
    const bad = decided && ['REGRETTED', 'EXPIRED'].includes(result.status);

    const steps = [];
    if (booking.atDoor) {
      steps.push(stepItem('bad', 'Turned away at the door', '409 WAITLIST_FULL: every berth and waitlist place was already gone, so nothing was queued', '!'));
    } else {
      steps.push(stepItem(view.stage === 'sending' ? 'active' : 'done', 'Request accepted',
        booking.acceptedMs ? '202 in ' + booking.acceptedMs + ' ms · ' + booking.requestId : 'sending…', '1'));
      steps.push(stepItem(view.stage === 'sending' ? 'idle' : decided ? 'done' : 'active', 'Waiting for a booking thread',
        view.error ? view.error
          : decided ? (booking.polls || 0) + ' poll' + (booking.polls === 1 ? '' : 's') + ', each waiting as long as the server said'
            : view.retry ? 'asking again in ' + view.retry + ' ms, as the server says' : 'in the queue', '2'));
      steps.push(stepItem(decided ? (bad ? 'bad' : 'done') : 'idle', decided ? headline(result) : 'The decision',
        decided ? describe(result) : '', '3'));
    }

    box.replaceChildren(el('ol', { class: 'timeline' }, steps), decided ? outcome(booking, result) : null);
    if (decided && (result.status === 'HELD' || result.status === 'WAITLIST_HELD') && result.payBy) startCountdown(result.payBy);
  }

  function stepItem(kind, title, meta, mark) {
    return el('li', { class: 'tl-step ' + kind },
      el('span', { class: 'tl-dot', 'aria-hidden': 'true' }, kind === 'done' ? '✓' : kind === 'bad' ? '!' : kind === 'active' ? '' : mark),
      el('div', {}, el('p', { class: 'tl-title' }, title), meta ? el('p', { class: 'tl-meta' }, meta) : null));
  }

  function headline(result) {
    switch (result.status) {
      case 'HELD': return 'Berth held for you';
      case 'WAITLIST_HELD': return 'Waitlist place held for you';
      case 'CONFIRMED': return 'Confirmed';
      case 'WAITLISTED': return 'On the waitlist';
      case 'REGRETTED': return 'Sold out';
      case 'EXPIRED': return 'Hold expired';
      case 'CANCELLED': return 'Cancelled';
      default: return result.status;
    }
  }

  function outcome(booking, result) {
    const again = el('button', { type: 'button', class: 'btn btn-quiet', onclick: bookAnother }, 'Book another');
    const status = el('p', { class: 'pay-status', id: 'pay-status', role: 'status', hidden: true });

    if (result.status === 'HELD' || result.status === 'WAITLIST_HELD') {
      const held = result.status === 'HELD';
      const cancelButton = el('button', { type: 'button', class: 'btn btn-danger', 'data-label': 'Cancel', onclick: (e) => cancel(e.currentTarget) }, 'Cancel');
      return el('div', { class: 'outcome o-held' },
        el('div', { class: 'outcome-head' },
          el('span', { class: 'berth' }, held ? result.seat : 'WL ' + result.position),
          el('div', {},
            el('h3', {}, held ? 'Berth ' + result.seat + ' is yours for now' : 'Waitlist place ' + result.position + ' is yours for now'),
            el('p', { class: 'muted' }, 'Pay before the timer runs out, or it goes to the next person in line.'))),
        el('div', { class: 'timer' }, el('strong', { id: 'countdown' }, '–:––'), el('span', { class: 'muted small' }, 'left to pay')),
        el('div', { class: 'fare-line' },
          el('span', {}, 'Fare ' + rupees(FARES[booking.coachClass])),
          el('span', {}, '3% fee ' + rupees(totalFor(booking.coachClass) - FARES[booking.coachClass])),
          el('strong', {}, 'Total ' + rupees(totalFor(booking.coachClass)))),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn-pay', disabled: !!booking.paidAt, onclick: (e) => pay(e.currentTarget) },
            booking.paidAt ? 'Paid, confirming…' : 'Pay ' + rupees(totalFor(booking.coachClass))),
          cancelButton),
        status);
    }

    if (result.status === 'CONFIRMED' || result.status === 'WAITLISTED') {
      const confirmed = result.status === 'CONFIRMED';
      const cancelButton = el('button', { type: 'button', class: 'btn btn-danger', 'data-label': 'Cancel ticket', onclick: (e) => cancel(e.currentTarget) }, 'Cancel ticket');
      return el('div', { class: 'journey' },
        el('div', { class: 'ticket' },
          el('div', { class: 'ticket-main' },
            el('div', {}, el('p', { class: 'ticket-label' }, 'PNR'), el('p', { class: 'pnr' }, result.pnr || '—')),
            el('dl', { class: 'ticket-grid' },
              ticketField('Train', booking.train + ' ' + booking.name),
              ticketField('Date', niceDate(booking.date)),
              ticketField('Class', booking.coachClass + ' · ' + CLASS_NAMES[booking.coachClass]),
              ticketField(confirmed ? 'Berth' : 'Waitlist', confirmed ? result.seat : 'position ' + result.position),
              ticketField('Passenger', booking.passenger.name),
              ticketField('Mail', 'ticket sent to ' + booking.passenger.email))),
          el('div', { class: 'ticket-stub' }, el('span', { class: 'stamp' }, confirmed ? 'CONFIRMED' : 'WAITLIST'))),
        el('div', { class: 'actions' }, cancelButton, again),
        status);
    }

    const message = {
      REGRETTED: booking.atDoor
        ? 'The door checked the waitlist counter in one read and said no, so the request never reached the queue.'
        : 'A booking thread found no free berth and no waitlist place left.',
      EXPIRED: 'The hold was not paid for in time, so the berth went back to the next person waiting.',
      CANCELLED: result.refund
        ? 'A refund is on its way. The 3% fee is not refunded: it is what covers the payment gateway\'s cut.'
        : 'The booking was given up.'
    }[result.status] || '';
    return el('div', { class: 'outcome ' + (result.status === 'CANCELLED' ? 'o-soft' : 'o-bad') },
      el('div', {}, el('h3', {}, headline(result)), el('p', { class: 'muted' }, message)),
      el('div', { class: 'actions' }, again));
  }

  function ticketField(label, value) {
    return el('div', {}, el('dt', {}, label), el('dd', {}, value));
  }

  // ---------- start ----------

  function init() {
    $('#api-host').textContent = new URL(API).host;
    for (const link of document.querySelectorAll('[data-github]')) link.href = window.MIDDLEBERTH.github;
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
    $('#auth-form').addEventListener('submit', submitAuth);
    $('#sign-out').addEventListener('click', () => signOut(null, true));
    $('#book-form').addEventListener('submit', submitBooking);
    for (const button of document.querySelectorAll('.copy')) {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          button.textContent = 'Copied';
        } catch (e) {
          button.textContent = 'Copy failed';
        }
        setTimeout(() => { button.textContent = 'Copy'; }, 1500);
      });
    }
    renderAuth();
    loadTrains();
    if (state.booking) resumeBooking();
  }

  init();
})();
