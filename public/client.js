
let username = window.localStorage.getItem('username');
let password = window.localStorage.getItem('password');
let vapidPublicKey = window.localStorage.getItem('vapidPublicKey');

async function initLogin() {
  if (!username) {
    username = (prompt('Username') || '').toLowerCase();
    password = prompt('Password');
  }
  const resp = await fetch('/subscribe', {
    method: 'post',
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json',
      'authorization': username + ':' + password,
    }
  });
  if (resp.status === 200) {
    vapidPublicKey = (await resp.json()).vapidPublicKey;
    console.log(vapidPublicKey)
    window.localStorage.setItem('username', username);
    window.localStorage.setItem('password', password);
  } else {
    alert('Invalid username or password');
    window.localStorage.removeItem('username');
    window.localStorage.removeItem('password');
  }
}


window.addEventListener('load', async () => {
  await initLogin();
  await initServiceWorker();
  updatePrompt();
});

//------------------------------------------------------------------------
// Notification Prompt
//------------------------------------------------------------------------

function updatePrompt() {
  if ('Notification' in window) {
    if (Notification.permission == 'granted' || Notification.permission == 'denied') {
      promptLink.style.display = 'none';
    } else {
      promptLink.style.display = 'block';
    }
  }
}

function onPromptClick() {
  if ('Notification' in window) {
    Notification.requestPermission().then((permission) => {
      updatePrompt();
      if (permission === 'granted') {
        console.log('Notification permission granted.');
        initServiceWorker();
      } else if (permission === 'denied') {
        console.warn('Notification permission denied.');
      }
    });
  }
}

//------------------------------------------------------------------------
// Init Service Worker
//------------------------------------------------------------------------

async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
    console.log('Initializing service worker');
    const swRegistration = await navigator.serviceWorker.ready;
    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      console.log('User is already subscribed:', subscription);
      sendSubscriptionToServer(subscription);
    } else {
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidPublicKey
      });
      console.log('User subscribed:', subscription);
      sendSubscriptionToServer(subscription);
    }
  } else {
    console.warn('Service worker is not supported');
  }
  console.log('Service worker initialized');
}

function sendSubscriptionToServer(subscription) {
  console.log('Sending subscription to server:', subscription);
  fetch('/subscribe', {
    method: 'post',
    body: JSON.stringify(subscription),
    headers: {
      'content-type': 'application/json',
      'authorization': username + ':' + password,
    }
  });
}
