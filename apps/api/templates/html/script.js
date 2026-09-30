// This code runs in the browser when the page loads.
const button = document.getElementById('counter');
let clicks = 0;

button.addEventListener('click', () => {
  clicks = clicks + 1;
  button.textContent = `Clicked ${clicks} times`;
});
