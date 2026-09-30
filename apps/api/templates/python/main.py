"""A friendly first Python program. Run it with: python3 main.py"""


def ask(question):
    """Asks a question in the terminal and returns the answer ("" if there is none)."""
    try:
        return input(question).strip()
    except EOFError:
        print()
        return ""


def main():
    name = ask("What's your name? ") or "friend"
    print(f"Hello, {name}! Welcome to Python.")

    answer = ask("Pick a number: ")
    if not answer:
        print("No number this time. That's OK. See you soon!")
        return
    try:
        number = float(answer)
    except ValueError:
        print(f'"{answer}" is not a number, but that\'s OK. Try again next time!')
        return
    if number.is_integer():
        number = int(number)
    print(f"{number} times 2 is {number * 2}.")


if __name__ == "__main__":
    main()
