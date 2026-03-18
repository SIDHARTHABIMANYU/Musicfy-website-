import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, getDocs, deleteDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBW_oGTZYSy0qoCnrFuD_VJB9yiA9ZvN_Y",
  authDomain: "musicfy-caa9a.firebaseapp.com",
  projectId: "musicfy-caa9a",
  storageBucket: "musicfy-caa9a.firebasestorage.app",
  messagingSenderId: "82783037582",
  appId: "1:82783037582:web:4a7ac8e534252c223881df",
  measurementId: "G-ZFST46CQND"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

export {
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    doc,
    setDoc,
    getDoc,
    collection,
    addDoc,
    getDocs,
    deleteDoc
};
