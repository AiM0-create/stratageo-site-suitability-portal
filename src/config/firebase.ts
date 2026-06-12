import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDd72e3Lci55rvyK2y8rK3srChQ-bi-470',
  authDomain: 'stratageo-location-intel-prod.firebaseapp.com',
  projectId: 'stratageo-location-intel-prod',
  storageBucket: 'stratageo-location-intel-prod.firebasestorage.app',
  messagingSenderId: '1020081478981',
  appId: '1:1020081478981:web:c8d921bb79331bae12722c',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Admin emails — unlimited prompts + analytics dashboard
export const ADMIN_EMAILS: string[] = [
  'abhishek.rawat@stratageo.in',
  'sagar.mysorekar@stratageo.in',
];

export const MAX_PROMPTS_PER_USER = 10;
