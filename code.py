import os
import json

# Replace with your Groq API KEY
API_KEY = "YOUR_GROQ_API_KEY"

def get_groq_api_header():
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }


import pyttsx3
import speech_recognition as sr
import json
import requests

class JarvisBot:
    def __init__(self):
        self.engine = pyttsx3.init()

    def speech_to_text(self):
        r = sr.Recognizer()
        with sr.Microphone() as source:
            print("Say something...")
            audio = r.listen(source)
            try:
                text = r.recognize_google(audio)
                return text
            except sr.UnknownValueError:
                print("Could not understand audio")
                return None
            except sr.RequestError as e:
                print(f"Error; {e}")
                return None

    def send_request(self, method, query):
        headers = get_groq_api_header()
        payload = {"query": query}
        response = requests.request(method, "https://groq.ai/v1/execute", headers=headers, json=payload)
        data = response.json()
        return data

    def get_response(self, response):
        if "error" in response:
            self.engine.say("Sorry, I didn't understand that.")
            self.engine.runAndWait()
            return None
        else:
            answer = response['result']
            self.engine.say(answer)
            self.engine.runAndWait()
            return answer

    def start_conversation(self):
        while True:
            text = self.speech_to_text()
            if text:
                query = {"question": text}
                response = self.send_request("POST", json.dumps(query))
                self.get_response(response)

    def shutdown(self):
        self.engine.say("Goodbye!")
        self.engine.runAndWait()

def main():
    jarvis = JarvisBot()
    print("Welcome to Jarvis!")
    while True:
        text = jarvis.speech_to_text()
        if text and "exit" in text:
            jarvis.shutdown()
            break
        elif text:
            query = {"question": text}
            response = jarvis.send_request("POST", json.dumps(query))
            jarvis.get_response(response)
        else:
            pass

if __name__ == "__main__":
    main()