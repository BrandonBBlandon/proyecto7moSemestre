const app = require('./app');

const port = Number( 3000);

app.listen(port, () => {
  console.log(`API de monitoreo de humo corriendo en el puerto: ${port}`);
});
