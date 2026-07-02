import bcrypt from "bcryptjs";

const password = 'Arenig#lean3';

bcrypt.hash(password, 10, (err, hash) => {
  if (err) throw err;
  console.log('Hashed Password:', hash);
});
