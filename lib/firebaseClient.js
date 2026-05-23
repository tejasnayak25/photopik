import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  // Fill from env in runtime
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

export { db }
