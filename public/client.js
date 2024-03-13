
let username = window.localStorage.getItem('username');
let password = window.localStorage.getItem('password');

async function initLogin() {
  if (!username) {
    username = prompt('Username');
    password = prompt('Password');
  }
  const resp = await fetch('/subscribe', {
    method: 'post',
    body: JSON.stringify({ username, password }),
    headers: { 'content-type': 'application/json' }
  });
  if (resp.status === 200) {
    window.localStorage.setItem('username', username);
    window.localStorage.setItem('password', password);
  } else {
    alert('Invalid username or password');
    window.localStorage.removeItem('username');
    window.localStorage.removeItem('password');
    window.location.reload();
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

const vapidPublicKey = VAPID_PUBLIC_KEY;

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
    body: JSON.stringify({username, password, ...JSON.parse(JSON.stringify(subscription))}),
    headers: { 'content-type': 'application/json' }
  });
}
