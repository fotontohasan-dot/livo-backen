import re
import os

def check_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    scripts = re.findall(r'<script>(.*?)</script>', content, re.DOTALL)
    for i, script in enumerate(scripts):
        temp_file = f"temp_script_{i}.js"
        with open(temp_file, 'w') as f:
            f.write(script)

        ret = os.system(f"node -c {temp_file}")
        os.remove(temp_file)
        if ret != 0:
            print(f"Syntax error in {filepath} script {i}")
            return False
    return True

if __name__ == "__main__":
    import sys
    for arg in sys.argv[1:]:
        check_file(arg)
